package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
	redislogging "github.com/redis/go-redis/v9/logging"
)

const sessionCookie = "cormier_session"
const realtimeProtocol = "cormier.realtime.v1"
const maximumBodyBytes = 64 << 10

var sessionIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,256}$`)
var sdkAssetPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

type App struct {
	config      Config
	store       *SessionStore
	client      *http.Client
	connections *websocketRegistry
}

type managedWebSocket interface {
	Close(websocket.StatusCode, string) error
	CloseNow() error
}

type websocketRegistry struct {
	mu          sync.Mutex
	connections map[managedWebSocket]struct{}
	closing     bool
	wait        sync.WaitGroup
}

func newWebsocketRegistry() *websocketRegistry {
	return &websocketRegistry{connections: make(map[managedWebSocket]struct{})}
}

func (registry *websocketRegistry) register(connection managedWebSocket) bool {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if registry.closing {
		return false
	}
	registry.connections[connection] = struct{}{}
	registry.wait.Add(1)
	return true
}

func (registry *websocketRegistry) unregister(connection managedWebSocket) {
	registry.mu.Lock()
	if _, exists := registry.connections[connection]; exists {
		delete(registry.connections, connection)
		registry.wait.Done()
	}
	registry.mu.Unlock()
}

func (registry *websocketRegistry) shutdown(ctx context.Context) error {
	registry.mu.Lock()
	registry.closing = true
	connections := make([]managedWebSocket, 0, len(registry.connections))
	for connection := range registry.connections {
		connections = append(connections, connection)
	}
	registry.mu.Unlock()

	for _, connection := range connections {
		go func() { _ = connection.Close(websocket.StatusGoingAway, "server shutting down") }()
	}
	drained := make(chan struct{})
	go func() {
		registry.wait.Wait()
		close(drained)
	}()
	select {
	case <-drained:
		return nil
	case <-ctx.Done():
		for _, connection := range connections {
			_ = connection.CloseNow()
		}
		return ctx.Err()
	}
}

type SessionRecord struct {
	TenantID      string    `json:"tenantId"`
	UserID        string    `json:"userId"`
	AllowedTopics []string  `json:"allowedTopics"`
	ExpiresAt     time.Time `json:"expiresAt"`
	Revoked       bool      `json:"revoked"`
}
type LoginRequest struct {
	TenantID string `json:"tenantId"`
	UserID   string `json:"userId"`
}

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	if err := run(); err != nil {
		slog.Error("application startup failed", "event", "startup_failed")
		os.Exit(1)
	}
}

func run() error {
	redislogging.Disable()
	config, err := LoadConfig()
	if err != nil {
		return err
	}
	store, err := ConnectStore(config.RedisURL)
	if err != nil {
		return err
	}
	defer store.Close()
	transport := &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 10 * time.Second, IdleConnTimeout: 60 * time.Second}
	app := &App{config: config, store: store, client: &http.Client{Transport: transport, Timeout: 15 * time.Second}, connections: newWebsocketRegistry()}
	server := &http.Server{Addr: net.JoinHostPort(config.ListenHost, fmt.Sprintf("%d", config.Port)), Handler: app.router(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	result := make(chan error, 1)
	go func() { result <- server.Serve(listener) }()
	slog.Info("application started", "event", "application_started")
	select {
	case err = <-result:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		shutdownResults := make(chan error, 2)
		go func() { shutdownResults <- server.Shutdown(shutdownCtx) }()
		go func() { shutdownResults <- app.connections.shutdown(shutdownCtx) }()
		for range 2 {
			if err = <-shutdownResults; err != nil {
				return err
			}
		}
		if err = <-result; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	slog.Info("application stopped", "event", "application_stopped")
	return nil
}

func (a *App) router() http.Handler {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(safeRecovery(), securityHeaders())
	router.GET("/", func(c *gin.Context) { c.File(filepath.Join(a.config.SharedAssetRoot, "index.html")) })
	router.GET("/app.css", func(c *gin.Context) { c.File(filepath.Join(a.config.SharedAssetRoot, "app.css")) })
	router.GET("/app.js", func(c *gin.Context) { c.File(filepath.Join(a.config.SharedAssetRoot, "app.js")) })
	router.GET("/_content/Cormier.Realtime.Browser/:asset", func(c *gin.Context) {
		asset := c.Param("asset")
		if !sdkAssetPattern.MatchString(asset) {
			c.AbortWithStatus(http.StatusNotFound)
			return
		}
		c.File(filepath.Join(a.config.SDKAssetRoot, asset))
	})
	router.GET("/health", a.health)
	router.GET("/api/diagnostics", a.diagnostics)
	router.POST("/api/login", a.login)
	router.GET("/api/session", a.session)
	router.POST("/api/logout", a.logout)
	router.POST("/realtime/tickets", a.ticket)
	router.GET("/realtime/ws", a.websocket)
	return router
}

func safeRecovery() gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if recover() != nil {
				slog.Error("request failed", "event", "request_failed")
				c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"code": "internal_error", "message": "The request could not be completed."})
			}
		}()
		c.Next()
	}
}
func securityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		h := c.Writer.Header()
		h.Set("Cache-Control", "no-store")
		h.Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self'; style-src 'self'; script-src 'self'")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		c.Next()
	}
}

func dependencyContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, 5*time.Second)
}
func (a *App) health(c *gin.Context) {
	ctx, cancel := dependencyContext(c.Request.Context())
	defer cancel()
	if !a.store.Ready(ctx) {
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "healthy"})
}
func (a *App) diagnostics(c *gin.Context) {
	ctx, cancel := dependencyContext(c.Request.Context())
	defer cancel()
	redisStatus := "unavailable"
	if a.store.Ready(ctx) {
		redisStatus = "ready"
	}
	c.JSON(http.StatusOK, gin.H{"stack": "Go / Gin", "topology": a.config.Topology, "instance": a.config.InstanceName, "redis": redisStatus, "timestamp": time.Now().UTC().Format(time.RFC3339)})
}

func (a *App) requireOrigin(c *gin.Context) bool {
	if c.GetHeader("Origin") != a.config.PublicOrigin {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"code": "origin_rejected", "message": "The request Origin is not allowed."})
		return false
	}
	return true
}
func limitBody(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maximumBodyBytes)
}
func decodeLoginRequest(reader io.Reader) (LoginRequest, error) {
	var request LoginRequest
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return LoginRequest{}, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return LoginRequest{}, errors.New("login request contains trailing data")
	}
	return request, nil
}
func (a *App) login(c *gin.Context) {
	if !a.requireOrigin(c) {
		return
	}
	limitBody(c)
	request, err := decodeLoginRequest(c.Request.Body)
	var maximum *http.MaxBytesError
	if errors.As(err, &maximum) {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{"code": "invalid_request", "message": "The request is invalid."})
		return
	}
	if err != nil || !a.config.Allows(request.TenantID, request.UserID) {
		c.JSON(http.StatusBadRequest, gin.H{"code": "invalid_identity", "message": "Select a configured test tenant and user."})
		return
	}
	bytes := make([]byte, 24)
	if _, err := rand.Read(bytes); err != nil {
		unavailable(c)
		return
	}
	id := hex.EncodeToString(bytes)
	record := SessionRecord{request.TenantID, request.UserID, []string{"orders", "notifications"}, time.Now().UTC().Add(a.config.SessionLifetime), false}
	encoded, err := json.Marshal(record)
	if err != nil {
		unavailable(c)
		return
	}
	ctx, cancel := dependencyContext(c.Request.Context())
	defer cancel()
	if a.store.Put(ctx, a.config.SessionKey(id), string(encoded), a.config.SessionLifetime) != nil {
		unavailable(c)
		return
	}
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie(sessionCookie, id, int(a.config.SessionLifetime.Seconds()), "/", "", a.config.PublicOrigin[:5] == "https", true)
	c.JSON(http.StatusOK, gin.H{"tenantId": record.TenantID, "userId": record.UserID, "expiresAt": record.ExpiresAt.Format(time.RFC3339Nano)})
}
func (a *App) readSession(c *gin.Context) (SessionRecord, bool) {
	id, err := c.Cookie(sessionCookie)
	if err != nil || !sessionIDPattern.MatchString(id) {
		unauthorized(c)
		return SessionRecord{}, false
	}
	ctx, cancel := dependencyContext(c.Request.Context())
	defer cancel()
	value, err := a.store.Get(ctx, a.config.SessionKey(id))
	if errors.Is(err, redis.Nil) {
		unauthorized(c)
		return SessionRecord{}, false
	}
	if err != nil {
		unavailable(c)
		return SessionRecord{}, false
	}
	var record SessionRecord
	if json.Unmarshal([]byte(value), &record) != nil {
		unavailable(c)
		return SessionRecord{}, false
	}
	if record.Revoked || !record.ExpiresAt.After(time.Now().UTC()) {
		unauthorized(c)
		return SessionRecord{}, false
	}
	return record, true
}
func (a *App) session(c *gin.Context) {
	record, ok := a.readSession(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, gin.H{"authenticated": true, "tenantId": record.TenantID, "userId": record.UserID, "allowedTopics": record.AllowedTopics, "expiresAt": record.ExpiresAt.Format(time.RFC3339Nano)})
}
func (a *App) logout(c *gin.Context) {
	if !a.requireOrigin(c) {
		return
	}
	if id, err := c.Cookie(sessionCookie); err == nil && sessionIDPattern.MatchString(id) {
		ctx, cancel := dependencyContext(c.Request.Context())
		defer cancel()
		if a.store.Remove(ctx, a.config.SessionKey(id)) != nil {
			unavailable(c)
			return
		}
	}
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie(sessionCookie, "", -1, "/", "", a.config.PublicOrigin[:5] == "https", true)
	c.Status(http.StatusNoContent)
}
func unauthorized(c *gin.Context) {
	c.JSON(http.StatusUnauthorized, gin.H{"code": "authentication_required", "message": "Authentication is required."})
}
func unavailable(c *gin.Context) {
	c.JSON(http.StatusServiceUnavailable, gin.H{"code": "service_unavailable", "message": "The reference application dependency is unavailable."})
}

func (a *App) ticket(c *gin.Context) {
	if !a.requireOrigin(c) {
		return
	}
	limitBody(c)
	target := a.config.GatewayURL.ResolveReference(&url.URL{Path: "/realtime/tickets"})
	request, err := http.NewRequestWithContext(c.Request.Context(), http.MethodPost, target.String(), c.Request.Body)
	if err != nil {
		unavailable(c)
		return
	}
	request.Host = c.Request.Host
	for _, name := range []string{"Origin", "Cookie", "Content-Type"} {
		request.Header.Set(name, c.GetHeader(name))
	}
	request.Header.Set("X-Forwarded-Proto", a.config.PublicScheme())
	response, err := a.client.Do(request)
	if err != nil {
		unavailable(c)
		return
	}
	defer response.Body.Close()
	body, err := readLimitedResponse(response.Body)
	if err != nil {
		unavailable(c)
		return
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "" {
		c.Header("Content-Type", contentType)
	}
	c.Data(response.StatusCode, c.Writer.Header().Get("Content-Type"), body)
}

func readLimitedResponse(reader io.Reader) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(reader, maximumBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maximumBodyBytes {
		return nil, errors.New("upstream response exceeds limit")
	}
	return body, nil
}

type hostTransport struct {
	base http.RoundTripper
	host string
}

func (t hostTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	clone.Host = t.host
	return t.base.RoundTrip(clone)
}
func (a *App) websocket(c *gin.Context) {
	if !a.requireOrigin(c) {
		return
	}
	browser, err := websocket.Accept(c.Writer, c.Request, &websocket.AcceptOptions{Subprotocols: []string{realtimeProtocol}, InsecureSkipVerify: true})
	if err != nil {
		return
	}
	if browser.Subprotocol() != realtimeProtocol {
		_ = browser.Close(websocket.StatusPolicyViolation, "required subprotocol")
		return
	}
	if !a.connections.register(browser) {
		_ = browser.Close(websocket.StatusGoingAway, "server shutting down")
		return
	}
	defer a.connections.unregister(browser)
	browser.SetReadLimit(maximumBodyBytes)
	defer browser.CloseNow()
	target := *a.config.GatewayURL
	if target.Scheme == "https" {
		target.Scheme = "wss"
	} else {
		target.Scheme = "ws"
	}
	target.Path = "/realtime/ws"
	target.RawQuery = c.Request.URL.RawQuery
	headers := http.Header{
		"Origin":            []string{a.config.PublicOrigin},
		"X-Forwarded-Proto": []string{a.config.PublicScheme()},
	}
	if cookie := c.GetHeader("Cookie"); cookie != "" {
		headers.Set("Cookie", cookie)
	}
	outbound := *a.client
	outbound.Timeout = 0
	outbound.Transport = hostTransport{a.client.Transport, c.Request.Host}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 15*time.Second)
	gateway, _, err := websocket.Dial(ctx, target.String(), &websocket.DialOptions{Subprotocols: []string{realtimeProtocol}, HTTPHeader: headers, HTTPClient: &outbound})
	cancel()
	if err != nil {
		_ = browser.Close(websocket.StatusTryAgainLater, "dependency unavailable")
		return
	}
	gateway.SetReadLimit(maximumBodyBytes)
	defer gateway.CloseNow()
	relayCtx, stop := context.WithCancel(c.Request.Context())
	defer stop()
	done := make(chan struct{}, 2)
	go relay(relayCtx, gateway, browser, done)
	go relay(relayCtx, browser, gateway, done)
	<-done
	stop()
	<-done
}
func relay(ctx context.Context, destination, source *websocket.Conn, done chan<- struct{}) {
	defer func() { done <- struct{}{} }()
	for {
		kind, data, err := source.Read(ctx)
		if err != nil {
			var closeError websocket.CloseError
			if errors.As(err, &closeError) {
				_ = destination.Close(closeError.Code, closeError.Reason)
			}
			return
		}
		if destination.Write(ctx, kind, data) != nil {
			return
		}
	}
}

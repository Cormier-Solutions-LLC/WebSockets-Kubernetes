package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type fakeManagedWebSocket struct {
	closed chan struct{}
	code   websocket.StatusCode
}

func (connection *fakeManagedWebSocket) Close(code websocket.StatusCode, _ string) error {
	connection.code = code
	close(connection.closed)
	return nil
}

func (connection *fakeManagedWebSocket) CloseNow() error { return nil }

func testValues() map[string]string {
	return map[string]string{"LISTEN_HOST": "127.0.0.1", "PORT": "15500", "PUBLIC_ORIGIN": "http://127.0.0.1:15500", "GATEWAY_URL": "http://127.0.0.1:15501", "REDIS_URL": "redis://127.0.0.1:6379", "SESSION_LIFETIME_SECONDS": "1200", "INSTANCE_NAME": "go-gin-a", "TOPOLOGY": "non-ha", "REDIS_INSTANCE_PREFIX": "cormier:go-test", "REDIS_SESSION_KEY_PREFIX": "sessions", "ALLOWED_TENANTS": "tenant-a", "ALLOWED_USERS": "user-a"}
}
func TestTypedConfiguration(t *testing.T) {
	values := testValues()
	config, err := loadConfig(func(key string) (string, bool) { value, ok := values[key]; return value, ok })
	if err != nil || config.ListenHost != "127.0.0.1" || config.Port != 15500 {
		t.Fatalf("valid configuration: %v", err)
	}
	if config.PublicScheme() != "http" {
		t.Fatalf("unexpected public scheme: %s", config.PublicScheme())
	}
	values["PUBLIC_ORIGIN"] = "file:///tmp"
	if _, err = loadConfig(func(key string) (string, bool) { value, ok := values[key]; return value, ok }); err == nil {
		t.Fatal("unsafe origin was accepted")
	}
	values["PUBLIC_ORIGIN"] = "https://example.test:443"
	if _, err = loadConfig(func(key string) (string, bool) { value, ok := values[key]; return value, ok }); err == nil {
		t.Fatal("explicit default origin port was accepted")
	}
	values["PUBLIC_ORIGIN"] = "https://EXAMPLE.TEST"
	if _, err = loadConfig(func(key string) (string, bool) { value, ok := values[key]; return value, ok }); err == nil {
		t.Fatal("noncanonical origin casing was accepted")
	}
	values["PUBLIC_ORIGIN"] = "https://example.test:99999"
	if _, err = loadConfig(func(key string) (string, bool) { value, ok := values[key]; return value, ok }); err == nil {
		t.Fatal("out-of-range origin port was accepted")
	}
}
func TestCanonicalContracts(t *testing.T) {
	values := testValues()
	schema, err := os.ReadFile("../shared-web/reference-app.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	for key := range values {
		if !strings.Contains(string(schema), `"`+key+`"`) {
			t.Errorf("schema missing %s", key)
		}
	}
	sdk, err := os.ReadFile("../../sdk/typescript/dist/version.json")
	if err != nil || !strings.Contains(string(sdk), `"protocolVersion": "1.0"`) {
		t.Fatal("SDK protocol contract mismatch")
	}
	protocol, err := os.ReadFile("../../protocol/fixtures/v1/envelopes.json")
	if err != nil || !strings.Contains(string(protocol), `"protocolVersion": "1.0"`) {
		t.Fatal("fixture protocol contract mismatch")
	}
}

func TestLoginDecoderRejectsTrailingData(t *testing.T) {
	valid := `{"tenantId":"tenant-a","userId":"user-a"}`
	if _, err := decodeLoginRequest(strings.NewReader(valid)); err != nil {
		t.Fatalf("valid login request rejected: %v", err)
	}
	for _, payload := range []string{valid + ` {}`, valid + ` garbage`} {
		if _, err := decodeLoginRequest(strings.NewReader(payload)); err == nil {
			t.Fatalf("trailing login data accepted: %q", payload)
		}
	}
}

func TestLoginDecoderReportsOversizedBodies(t *testing.T) {
	payload := `{"tenantId":"` + strings.Repeat("a", maximumBodyBytes) + `"}`
	reader := http.MaxBytesReader(httptest.NewRecorder(), io.NopCloser(strings.NewReader(payload)), maximumBodyBytes)
	_, err := decodeLoginRequest(reader)
	var maximum *http.MaxBytesError
	if !errors.As(err, &maximum) {
		t.Fatalf("oversized body did not return MaxBytesError: %v", err)
	}
}

func TestTicketResponseLimitRejectsOverflow(t *testing.T) {
	boundary := strings.Repeat("a", maximumBodyBytes)
	body, err := readLimitedResponse(strings.NewReader(boundary))
	if err != nil || len(body) != maximumBodyBytes {
		t.Fatalf("boundary response rejected: size=%d error=%v", len(body), err)
	}
	if _, err = readLimitedResponse(strings.NewReader(boundary + "b")); err == nil {
		t.Fatal("oversized response was truncated instead of rejected")
	}
}

func TestWebsocketRegistryDrainsAndRejectsNewConnections(t *testing.T) {
	registry := newWebsocketRegistry()
	connection := &fakeManagedWebSocket{closed: make(chan struct{})}
	if !registry.register(connection) {
		t.Fatal("initial connection was rejected")
	}
	go func() {
		<-connection.closed
		registry.unregister(connection)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := registry.shutdown(ctx); err != nil {
		t.Fatalf("drain failed: %v", err)
	}
	if connection.code != websocket.StatusGoingAway {
		t.Fatalf("unexpected close code: %d", connection.code)
	}
	if registry.register(&fakeManagedWebSocket{closed: make(chan struct{})}) {
		t.Fatal("connection registered after shutdown began")
	}
}

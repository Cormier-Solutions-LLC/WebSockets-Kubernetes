package main

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var safeIdentifier = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
var safePrefix = regexp.MustCompile(`^[A-Za-z0-9._:-]+$`)

type Config struct {
	ListenHost            string
	Port                  int
	PublicOrigin          string
	GatewayURL            *url.URL
	RedisURL              string
	SessionLifetime       time.Duration
	InstanceName          string
	Topology              string
	RedisInstancePrefix   string
	RedisSessionKeyPrefix string
	AllowedTenants        map[string]struct{}
	AllowedUsers          map[string]struct{}
	SharedAssetRoot       string
	SDKAssetRoot          string
}

func LoadConfig() (Config, error) { return loadConfig(os.LookupEnv) }

func loadConfig(lookup func(string) (string, bool)) (Config, error) {
	required := func(name string) (string, error) {
		value, ok := lookup(name)
		if !ok || strings.TrimSpace(value) == "" {
			return "", fmt.Errorf("required configuration is missing")
		}
		return value, nil
	}
	listenHost, err := required("LISTEN_HOST")
	if err != nil || !safePrefix.MatchString(listenHost) || len(listenHost) > 253 {
		return Config{}, fmt.Errorf("LISTEN_HOST is invalid")
	}
	portValue, err := required("PORT")
	if err != nil {
		return Config{}, err
	}
	port, err := strconv.Atoi(portValue)
	if err != nil || port < 1024 || port > 65535 {
		return Config{}, fmt.Errorf("PORT is invalid")
	}
	lifetimeValue, err := required("SESSION_LIFETIME_SECONDS")
	if err != nil {
		return Config{}, err
	}
	lifetime, err := strconv.Atoi(lifetimeValue)
	if err != nil || lifetime < 60 || lifetime > 7200 {
		return Config{}, fmt.Errorf("session lifetime is invalid")
	}
	publicValue, err := required("PUBLIC_ORIGIN")
	if err != nil {
		return Config{}, err
	}
	publicOrigin, _, err := parseOrigin(publicValue)
	if err != nil {
		return Config{}, err
	}
	gatewayValue, err := required("GATEWAY_URL")
	if err != nil {
		return Config{}, err
	}
	_, gatewayURL, err := parseOrigin(gatewayValue)
	if err != nil {
		return Config{}, err
	}
	redisURL, err := required("REDIS_URL")
	if err != nil {
		return Config{}, err
	}
	parsedRedis, err := url.Parse(redisURL)
	if err != nil || (parsedRedis.Scheme != "redis" && parsedRedis.Scheme != "rediss") || parsedRedis.Hostname() == "" || parsedRedis.Fragment != "" {
		return Config{}, fmt.Errorf("REDIS_URL is invalid")
	}
	instance, err := required("INSTANCE_NAME")
	if err != nil || !validIdentifier(instance, false) {
		return Config{}, fmt.Errorf("INSTANCE_NAME is invalid")
	}
	topology, err := required("TOPOLOGY")
	if err != nil || (topology != "ha" && topology != "non-ha") {
		return Config{}, fmt.Errorf("TOPOLOGY is invalid")
	}
	prefix, err := required("REDIS_INSTANCE_PREFIX")
	if err != nil || !validIdentifier(prefix, true) {
		return Config{}, fmt.Errorf("REDIS_INSTANCE_PREFIX is invalid")
	}
	sessionPrefix, err := required("REDIS_SESSION_KEY_PREFIX")
	if err != nil || !validIdentifier(sessionPrefix, false) {
		return Config{}, fmt.Errorf("REDIS_SESSION_KEY_PREFIX is invalid")
	}
	tenantValue, err := required("ALLOWED_TENANTS")
	if err != nil {
		return Config{}, err
	}
	tenants, err := parseList(tenantValue)
	if err != nil {
		return Config{}, err
	}
	userValue, err := required("ALLOWED_USERS")
	if err != nil {
		return Config{}, err
	}
	users, err := parseList(userValue)
	if err != nil {
		return Config{}, err
	}
	sharedRoot := "../shared-web/wwwroot"
	if value, ok := lookup("SHARED_ASSET_ROOT"); ok && value != "" {
		sharedRoot = value
	}
	sdkRoot := "../../sdk/typescript/dist"
	if value, ok := lookup("SDK_ASSET_ROOT"); ok && value != "" {
		sdkRoot = value
	}
	return Config{listenHost, port, publicOrigin, gatewayURL, redisURL, time.Duration(lifetime) * time.Second, instance, topology, prefix, sessionPrefix, tenants, users, filepath.Clean(sharedRoot), filepath.Clean(sdkRoot)}, nil
}

func parseOrigin(value string) (string, *url.URL, error) {
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") || (parsed.Scheme == "http" && parsed.Port() == "80") || (parsed.Scheme == "https" && parsed.Port() == "443") {
		return "", nil, fmt.Errorf("origin is invalid")
	}
	parsed.Path = ""
	return strings.TrimSuffix(parsed.String(), "/"), parsed, nil
}

func validIdentifier(value string, colon bool) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	if colon {
		return safePrefix.MatchString(value)
	}
	return safeIdentifier.MatchString(value)
}

func parseList(value string) (map[string]struct{}, error) {
	result := map[string]struct{}{}
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if !validIdentifier(item, false) {
			return nil, fmt.Errorf("allowlist is invalid")
		}
		result[item] = struct{}{}
	}
	return result, nil
}

func (c Config) Allows(tenant, user string) bool {
	_, tenantOK := c.AllowedTenants[tenant]
	_, userOK := c.AllowedUsers[user]
	return tenantOK && userOK
}
func (c Config) SessionKey(id string) string {
	return c.RedisInstancePrefix + ":" + c.RedisSessionKeyPrefix + ":" + id
}

package main

import (
	"os"
	"strings"
	"testing"
)

func testValues() map[string]string {
	return map[string]string{"LISTEN_HOST": "127.0.0.1", "PORT": "15500", "PUBLIC_ORIGIN": "http://127.0.0.1:15500", "GATEWAY_URL": "http://127.0.0.1:15501", "REDIS_URL": "redis://127.0.0.1:6379", "SESSION_LIFETIME_SECONDS": "1200", "INSTANCE_NAME": "go-gin-a", "TOPOLOGY": "non-ha", "REDIS_INSTANCE_PREFIX": "cormier:go-test", "REDIS_SESSION_KEY_PREFIX": "sessions", "ALLOWED_TENANTS": "tenant-a", "ALLOWED_USERS": "user-a"}
}
func TestTypedConfiguration(t *testing.T) {
	values := testValues()
	config, err := loadConfig(func(key string) (string, bool) { value, ok := values[key]; return value, ok })
	if err != nil || config.ListenHost != "127.0.0.1" || config.Port != 15500 {
		t.Fatalf("valid configuration: %v", err)
	}
	values["PUBLIC_ORIGIN"] = "file:///tmp"
	if _, err = loadConfig(func(key string) (string, bool) { value, ok := values[key]; return value, ok }); err == nil {
		t.Fatal("unsafe origin was accepted")
	}
	values["PUBLIC_ORIGIN"] = "https://example.test:443"
	if _, err = loadConfig(func(key string) (string, bool) { value, ok := values[key]; return value, ok }); err == nil {
		t.Fatal("explicit default origin port was accepted")
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

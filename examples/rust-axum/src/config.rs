use std::{collections::HashSet, env, path::PathBuf};
use url::Url;

#[derive(Clone)]
pub struct Config {
    pub listen_host: String,
    pub port: u16,
    pub public_origin: Url,
    pub gateway_url: Url,
    pub redis_url: String,
    pub session_lifetime_seconds: u64,
    pub instance_name: String,
    pub topology: String,
    pub redis_instance_prefix: String,
    pub redis_session_key_prefix: String,
    pub allowed_tenants: HashSet<String>,
    pub allowed_users: HashSet<String>,
    pub shared_asset_root: PathBuf,
    pub sdk_asset_root: PathBuf,
}

impl Config {
    pub fn load() -> Result<Self, &'static str> {
        Self::from_values(|name| env::var(name).ok())
    }

    fn from_values(get: impl Fn(&str) -> Option<String>) -> Result<Self, &'static str> {
        let required = |name| {
            get(name)
                .filter(|value| !value.trim().is_empty())
                .ok_or("required configuration is missing")
        };
        let listen_host = safe_host(required("LISTEN_HOST")?)?;
        let port = required("PORT")?.parse().map_err(|_| "PORT is invalid")?;
        if !(1024..=65535).contains(&port) {
            return Err("PORT is invalid");
        }
        let lifetime = required("SESSION_LIFETIME_SECONDS")?
            .parse()
            .map_err(|_| "session lifetime is invalid")?;
        if !(60..=7200).contains(&lifetime) {
            return Err("session lifetime is invalid");
        }
        let public_origin = origin(&required("PUBLIC_ORIGIN")?)?;
        let gateway_url = origin(&required("GATEWAY_URL")?)?;
        let redis_url = required("REDIS_URL")?;
        let parsed_redis = Url::parse(&redis_url).map_err(|_| "REDIS_URL is invalid")?;
        if !matches!(parsed_redis.scheme(), "redis" | "rediss")
            || parsed_redis.host_str().is_none()
            || parsed_redis.fragment().is_some()
        {
            return Err("REDIS_URL is invalid");
        }
        let instance_name = safe(required("INSTANCE_NAME")?, false)?;
        let topology = required("TOPOLOGY")?;
        if topology != "ha" && topology != "non-ha" {
            return Err("TOPOLOGY is invalid");
        }
        let redis_instance_prefix = safe(required("REDIS_INSTANCE_PREFIX")?, true)?;
        let redis_session_key_prefix = safe(required("REDIS_SESSION_KEY_PREFIX")?, false)?;
        let allowed_tenants = list(required("ALLOWED_TENANTS")?)?;
        let allowed_users = list(required("ALLOWED_USERS")?)?;
        Ok(Self {
            listen_host,
            port,
            public_origin,
            gateway_url,
            redis_url,
            session_lifetime_seconds: lifetime,
            instance_name,
            topology,
            redis_instance_prefix,
            redis_session_key_prefix,
            allowed_tenants,
            allowed_users,
            shared_asset_root: PathBuf::from(
                get("SHARED_ASSET_ROOT").unwrap_or_else(|| "../shared-web/wwwroot".into()),
            ),
            sdk_asset_root: PathBuf::from(
                get("SDK_ASSET_ROOT").unwrap_or_else(|| "../../sdk/typescript/dist".into()),
            ),
        })
    }

    pub fn allows(&self, tenant: &str, user: &str) -> bool {
        self.allowed_tenants.contains(tenant) && self.allowed_users.contains(user)
    }

    pub fn session_key(&self, id: &str) -> String {
        format!(
            "{}:{}:{}",
            self.redis_instance_prefix, self.redis_session_key_prefix, id
        )
    }
}

fn origin(value: &str) -> Result<Url, &'static str> {
    let lower = value.to_ascii_lowercase();
    let explicit_default_port = lower
        .strip_prefix("http://")
        .and_then(|rest| rest.split('/').next())
        .is_some_and(|authority| authority.ends_with(":80"))
        || lower
            .strip_prefix("https://")
            .and_then(|rest| rest.split('/').next())
            .is_some_and(|authority| authority.ends_with(":443"));
    let mut value = Url::parse(value).map_err(|_| "origin is invalid")?;
    if !matches!(value.scheme(), "http" | "https")
        || value.host_str().is_none()
        || !value.username().is_empty()
        || value.password().is_some()
        || value.query().is_some()
        || value.fragment().is_some()
        || value.path() != "/"
        || explicit_default_port
    {
        return Err("origin is invalid");
    }
    value.set_path("");
    Ok(value)
}

fn safe(value: String, colon: bool) -> Result<String, &'static str> {
    if value.len() > 128
        || value.is_empty()
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c) || (colon && c == ':'))
    {
        return Err("identifier is invalid");
    }
    Ok(value)
}

fn safe_host(value: String) -> Result<String, &'static str> {
    if value.len() > 253
        || value.is_empty()
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".:_-".contains(c))
    {
        return Err("LISTEN_HOST is invalid");
    }
    Ok(value)
}

fn list(value: String) -> Result<HashSet<String>, &'static str> {
    value
        .split(',')
        .map(|part| safe(part.trim().to_owned(), false))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn values() -> HashMap<&'static str, String> {
        HashMap::from([
            ("LISTEN_HOST", "127.0.0.1".into()),
            ("PORT", "15400".into()),
            ("PUBLIC_ORIGIN", "http://127.0.0.1:15400".into()),
            ("GATEWAY_URL", "http://127.0.0.1:15401".into()),
            ("REDIS_URL", "redis://127.0.0.1:6379".into()),
            ("SESSION_LIFETIME_SECONDS", "1200".into()),
            ("INSTANCE_NAME", "rust-axum-a".into()),
            ("TOPOLOGY", "non-ha".into()),
            ("REDIS_INSTANCE_PREFIX", "cormier:rust-test".into()),
            ("REDIS_SESSION_KEY_PREFIX", "sessions".into()),
            ("ALLOWED_TENANTS", "tenant-a".into()),
            ("ALLOWED_USERS", "user-a".into()),
        ])
    }

    #[test]
    fn validates_typed_configuration() {
        let values = values();
        let config = Config::from_values(|key| values.get(key).cloned()).unwrap();
        assert_eq!(config.port, 15400);
        assert_eq!(config.listen_host, "127.0.0.1");
        let mut invalid = values.clone();
        invalid.insert("PUBLIC_ORIGIN", "file:///tmp".into());
        assert!(Config::from_values(|key| invalid.get(key).cloned()).is_err());
        invalid.insert("PUBLIC_ORIGIN", "https://example.test:443".into());
        assert!(Config::from_values(|key| invalid.get(key).cloned()).is_err());
    }

    #[test]
    fn consumes_canonical_configuration_and_protocol_contracts() {
        let schema = std::fs::read_to_string("../shared-web/reference-app.schema.json").unwrap();
        for name in values().keys() {
            assert!(schema.contains(&format!("\"{name}\"")), "{name}");
        }
        let sdk = std::fs::read_to_string("../../sdk/typescript/dist/version.json").unwrap();
        let protocol =
            std::fs::read_to_string("../../protocol/fixtures/v1/envelopes.json").unwrap();
        assert!(sdk.contains("\"protocolVersion\": \"1.0\""));
        assert!(protocol.contains("\"protocolVersion\": \"1.0\""));
    }
}

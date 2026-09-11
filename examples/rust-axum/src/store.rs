use redis::{AsyncCommands, aio::ConnectionManager};
use std::time::Duration;

#[derive(Clone)]
pub struct SessionStore(ConnectionManager);

impl SessionStore {
    pub async fn connect(url: &str) -> Result<Self, redis::RedisError> {
        let client = redis::Client::open(url)?;
        let manager = tokio::time::timeout(Duration::from_secs(5), client.get_connection_manager())
            .await
            .map_err(|_| redis::RedisError::from((redis::ErrorKind::Io, "connection timeout")))??;
        Ok(Self(manager))
    }

    pub async fn ready(&self) -> bool {
        let mut connection = self.0.clone();
        tokio::time::timeout(
            Duration::from_secs(5),
            redis::cmd("PING").query_async::<String>(&mut connection),
        )
        .await
        .is_ok_and(|result| result.is_ok_and(|value| value == "PONG"))
    }

    pub async fn get(&self, key: &str) -> Result<Option<String>, redis::RedisError> {
        let mut connection = self.0.clone();
        connection.get(key).await
    }

    pub async fn put(&self, key: &str, value: &str, ttl: u64) -> Result<(), redis::RedisError> {
        let mut connection = self.0.clone();
        connection.set_ex(key, value, ttl).await
    }

    pub async fn remove(&self, key: &str) -> Result<(), redis::RedisError> {
        let mut connection = self.0.clone();
        connection.del(key).await
    }
}

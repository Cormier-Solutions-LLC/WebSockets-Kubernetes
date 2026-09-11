use redis::{AsyncCommands, aio::ConnectionManager};
use std::{future::Future, time::Duration};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

fn timeout_error() -> redis::RedisError {
    redis::RedisError::from((redis::ErrorKind::Io, "command timeout"))
}

async fn bounded_with_timeout<T>(
    duration: Duration,
    future: impl Future<Output = Result<T, redis::RedisError>>,
) -> Result<T, redis::RedisError> {
    tokio::time::timeout(duration, future)
        .await
        .map_err(|_| timeout_error())?
}

async fn bounded<T>(
    future: impl Future<Output = Result<T, redis::RedisError>>,
) -> Result<T, redis::RedisError> {
    bounded_with_timeout(COMMAND_TIMEOUT, future).await
}

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
        bounded(connection.get(key)).await
    }

    pub async fn put(&self, key: &str, value: &str, ttl: u64) -> Result<(), redis::RedisError> {
        let mut connection = self.0.clone();
        bounded(connection.set_ex(key, value, ttl)).await
    }

    pub async fn remove(&self, key: &str) -> Result<(), redis::RedisError> {
        let mut connection = self.0.clone();
        bounded(connection.del(key)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn command_deadline_returns_a_redis_error() {
        let result = bounded_with_timeout(
            Duration::from_millis(1),
            std::future::pending::<Result<(), redis::RedisError>>(),
        )
        .await;
        assert!(result.is_err());
    }
}

package com.cormier.realtime.example

import io.lettuce.core.RedisClient
import io.lettuce.core.RedisURI
import io.lettuce.core.SetArgs
import io.lettuce.core.api.StatefulRedisConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Duration

interface SessionStore : AutoCloseable {
    suspend fun ready(): Boolean
    suspend fun get(key: String): String?
    suspend fun put(key: String, value: String, ttlSeconds: Long): Boolean
    suspend fun remove(key: String): Boolean
}

class LettuceSessionStore private constructor(
    private val client: RedisClient,
    private val connection: StatefulRedisConnection<String, String>,
) : SessionStore {
    private val commands = connection.sync()

    override suspend fun ready() = io { commands.ping() == "PONG" }
    override suspend fun get(key: String) = io { commands.get(key) }
    override suspend fun put(key: String, value: String, ttlSeconds: Long) =
        io { commands.set(key, value, SetArgs.Builder.ex(ttlSeconds)) == "OK" }
    override suspend fun remove(key: String) = io { commands.del(key) > 0 }

    override fun close() {
        connection.close()
        client.shutdown(Duration.ZERO, Duration.ofSeconds(5))
    }

    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    companion object {
        fun connect(url: String): LettuceSessionStore {
            val uri = RedisURI.create(url).apply { timeout = Duration.ofSeconds(5) }
            val client = RedisClient.create(uri)
            return try {
                LettuceSessionStore(client, client.connect())
            } catch (error: Exception) {
                client.shutdown(Duration.ZERO, Duration.ofSeconds(5))
                throw error
            }
        }
    }
}

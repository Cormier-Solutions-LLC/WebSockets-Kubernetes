package com.cormier.realtime.example

import java.net.URI
import java.nio.file.Path

data class ReferenceConfig(
    val listenHost: String,
    val port: Int,
    val publicOrigin: URI,
    val gatewayUrl: URI,
    val redisUrl: String,
    val sessionLifetimeSeconds: Long,
    val instanceName: String,
    val topology: String,
    val redisInstancePrefix: String,
    val redisSessionKeyPrefix: String,
    val allowedTenants: Set<String>,
    val allowedUsers: Set<String>,
    val sharedAssetRoot: Path,
    val sdkAssetRoot: Path,
) {
    companion object {
        private val safeName = Regex("[A-Za-z0-9._-]{1,128}")
        private val safePrefix = Regex("[A-Za-z0-9._:-]{1,128}")

        fun load(environment: Map<String, String> = System.getenv()): ReferenceConfig {
            fun required(name: String) = environment[name]?.trim()?.takeIf(String::isNotEmpty)
                ?: error("$name is required")
            fun origin(name: String): URI {
                val value = URI(required(name)).normalize()
                require(value.toString() == value.toString().lowercase() && value.scheme in setOf("http", "https") && value.host != null && value.userInfo == null &&
                    (value.path.isNullOrEmpty() || value.path == "/") && value.query == null && value.fragment == null &&
                    (value.port == -1 || value.port in 1..65535) &&
                    !(value.scheme == "http" && value.port == 80) && !(value.scheme == "https" && value.port == 443)) {
                    "$name must be an HTTP(S) origin"
                }
                return URI(value.toString().removeSuffix("/"))
            }
            fun names(name: String) = required(name).split(',').map(String::trim).onEach {
                require(safeName.matches(it)) { "$name contains an invalid identifier" }
            }.toSet().also { require(it.isNotEmpty()) { "$name is required" } }

            val port = required("PORT").toIntOrNull()
            require(port != null && port in 1024..65535) { "PORT must be between 1024 and 65535" }
            val listenHost = required("LISTEN_HOST")
            require(Regex("[A-Za-z0-9._:-]{1,253}").matches(listenHost)) { "LISTEN_HOST is invalid" }
            val lifetime = required("SESSION_LIFETIME_SECONDS").toLongOrNull()
            require(lifetime != null && lifetime in 60..7200) { "SESSION_LIFETIME_SECONDS must be between 60 and 7200" }
            val instance = required("INSTANCE_NAME")
            require(safeName.matches(instance)) { "INSTANCE_NAME is invalid" }
            val topology = required("TOPOLOGY")
            require(topology == "ha" || topology == "non-ha") { "TOPOLOGY must be ha or non-ha" }
            val instancePrefix = required("REDIS_INSTANCE_PREFIX")
            require(safePrefix.matches(instancePrefix)) { "REDIS_INSTANCE_PREFIX is invalid" }
            val sessionPrefix = required("REDIS_SESSION_KEY_PREFIX")
            require(safeName.matches(sessionPrefix)) { "REDIS_SESSION_KEY_PREFIX is invalid" }
            val redis = URI(required("REDIS_URL"))
            require(redis.scheme in setOf("redis", "rediss") && redis.host != null && redis.fragment == null) {
                "REDIS_URL must be a Redis URI"
            }

            return ReferenceConfig(
                listenHost, port, origin("PUBLIC_ORIGIN"), origin("GATEWAY_URL"), redis.toString(), lifetime, instance, topology,
                instancePrefix, sessionPrefix, names("ALLOWED_TENANTS"), names("ALLOWED_USERS"),
                Path.of(environment["SHARED_ASSET_ROOT"] ?: "../shared-web/wwwroot"),
                Path.of(environment["SDK_ASSET_ROOT"] ?: "../../sdk/typescript/dist"),
            )
        }
    }

    fun allows(tenantId: String?, userId: String?) = tenantId in allowedTenants && userId in allowedUsers
    fun sessionKey(sessionId: String) = "$redisInstancePrefix:$redisSessionKeyPrefix:$sessionId"
}

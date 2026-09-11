import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.4.20"
    kotlin("plugin.serialization") version "2.4.20"
    id("io.ktor.plugin") version "3.5.2"
    application
}

group = "com.cormier.realtime.examples"
version = "0.1.0"

repositories { mavenCentral() }

dependencyLocking { lockAllConfigurations() }

dependencies {
    implementation("io.ktor:ktor-server-core:3.5.2")
    implementation("io.ktor:ktor-server-netty:3.5.2")
    implementation("io.ktor:ktor-server-content-negotiation:3.5.2")
    implementation("io.ktor:ktor-serialization-kotlinx-json:3.5.2")
    implementation("io.ktor:ktor-server-status-pages:3.5.2")
    implementation("io.ktor:ktor-server-websockets:3.5.2")
    implementation("io.ktor:ktor-client-core:3.5.2")
    implementation("io.ktor:ktor-client-cio:3.5.2")
    implementation("io.ktor:ktor-client-websockets:3.5.2")
    implementation("io.lettuce:lettuce-core:7.6.0.RELEASE")
    implementation("ch.qos.logback:logback-classic:1.5.20")

    testImplementation("io.ktor:ktor-server-test-host:3.5.2")
    testImplementation("io.ktor:ktor-client-mock:3.5.2")
    testImplementation(kotlin("test"))
}

application { mainClass.set("com.cormier.realtime.example.ApplicationKt") }

kotlin {
    jvmToolchain(25)
    compilerOptions.jvmTarget.set(JvmTarget.JVM_25)
}

tasks.test { useJUnitPlatform() }

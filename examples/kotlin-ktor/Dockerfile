ARG GRADLE_IMAGE=gradle:9.7.1-jdk25-alpine@sha256:a0991f96020bb532564c947a4bbea93d67befd3cc81b3e356eb1a85556701b6e
ARG JAVA_IMAGE=eclipse-temurin:25-jre-alpine@sha256:3137541deb3cac6626b5d9a4a2187bc0d6a34312f858bd2c67dd01e732e6b682
FROM ${GRADLE_IMAGE} AS build
WORKDIR /source
COPY examples/kotlin-ktor/settings.gradle.kts examples/kotlin-ktor/build.gradle.kts examples/kotlin-ktor/gradle.properties examples/kotlin-ktor/gradle.lockfile ./
COPY examples/kotlin-ktor/src ./src
RUN gradle --no-daemon buildFatJar

FROM ${JAVA_IMAGE}
RUN apk upgrade --no-cache
WORKDIR /app
COPY --from=build /source/build/libs/kotlin-ktor-all.jar ./application.jar
COPY examples/shared-web/dist ./shared-web
COPY sdk/typescript/dist ./sdk
ENV SHARED_ASSET_ROOT=/app/shared-web/optimized
ENV SDK_ASSET_ROOT=/app/sdk
USER 65532:65532
ENTRYPOINT ["java", "--enable-native-access=ALL-UNNAMED", "-jar", "/app/application.jar"]

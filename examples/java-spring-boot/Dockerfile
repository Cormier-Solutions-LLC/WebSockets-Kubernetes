FROM maven:3.9.12-eclipse-temurin-25-alpine@sha256:91fbbf32cc5076b6142ed98405f3a1a21e102d876eafa5eaf359b5591e8e3fd8 AS build
WORKDIR /source
COPY examples/java-spring-boot/pom.xml ./
RUN mvn --batch-mode dependency:go-offline
COPY examples/java-spring-boot/src ./src
RUN mvn --batch-mode package -DskipTests

FROM eclipse-temurin:25-jre-alpine@sha256:3137541deb3cac6626b5d9a4a2187bc0d6a34312f858bd2c67dd01e732e6b682
RUN apk upgrade --no-cache
WORKDIR /app
COPY --from=build /source/target/java-spring-boot-0.1.0.jar ./application.jar
COPY examples/shared-web/wwwroot ./shared-web
COPY sdk/typescript/dist ./sdk
ENV SHARED_ASSET_ROOT=/app/shared-web
ENV SDK_ASSET_ROOT=/app/sdk
USER 65532:65532
ENTRYPOINT ["java", "-jar", "/app/application.jar"]

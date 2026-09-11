import Foundation
import Logging
import Vapor

@main
enum EntryPoint {
  static func main() async {
    do {
      var environment = try Environment.detect()
      try LoggingSystem.bootstrap(from: &environment)
      let application = try await Application.make(environment)
      do {
        try configure(application)
        try await application.execute()
        application.logger.notice("application_stopped", metadata: ["stack": "swift-vapor"])
        try await application.asyncShutdown()
      } catch {
        application.logger.error(
          "startup_failed", metadata: ["stack": "swift-vapor", "errorType": "\(type(of: error))"])
        try? await application.asyncShutdown()
        exit(EXIT_FAILURE)
      }
    } catch {
      let event =
        "{\"event\":\"startup_failed\",\"stack\":\"swift-vapor\",\"errorType\":\"\(type(of: error))\"}\n"
      FileHandle.standardError.write(Data(event.utf8))
      exit(EXIT_FAILURE)
    }
  }
}

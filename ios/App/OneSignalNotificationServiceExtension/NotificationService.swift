import UserNotifications

import OneSignalExtension

/// OneSignal Notification Service Extension.
///
/// This is the canonical OneSignal NSE (SDK 5.x). It hands each incoming
/// remote notification to `OneSignalExtension` so OneSignal can:
///   - render rich media (images/attachments),
///   - report confirmed delivery,
///   - apply badge counts.
///
/// The `OneSignalExtension` product comes from the OneSignal-XCFramework Swift
/// Package. Under this project's SPM setup it must be linked to THIS extension
/// target explicitly (see docs/onesignal-ios-setup.md) — the app target's
/// dependency does not propagate to an app extension.
///
/// This target must share the App Group `group.app.lemonenglish.lemon.onesignal`
/// with the main app (see OneSignalNotificationServiceExtension.entitlements).
class NotificationService: UNNotificationServiceExtension {

    var contentHandler: ((UNNotificationContent) -> Void)?
    var receivedRequest: UNNotificationRequest!
    var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.receivedRequest = request
        self.contentHandler = contentHandler
        self.bestAttemptContent = (request.content.mutableCopy() as? UNMutableNotificationContent)

        if let bestAttemptContent = bestAttemptContent {
            OneSignalExtension.didReceiveNotificationExtensionRequest(
                self.receivedRequest,
                with: bestAttemptContent,
                withContentHandler: self.contentHandler
            )
        }
    }

    override func serviceExtensionTimeWillExpire() {
        // The system is about to reclaim the extension. Deliver the best
        // version of the notification we have so far.
        if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
            OneSignalExtension.serviceExtensionTimeWillExpireRequest(
                self.receivedRequest,
                with: bestAttemptContent
            )
            contentHandler(bestAttemptContent)
        }
    }
}

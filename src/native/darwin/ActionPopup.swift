import AppKit
import Foundation

let windowWidth: CGFloat = 148
let windowHeight: CGFloat = 28
let closeButtonWidth: CGFloat = 24
let outerMargin: CGFloat = 1

var label = "Send to Codex"
var offsetX: CGFloat = 12
var offsetY: CGFloat = 18

if let data = try? FileHandle.standardInput.readToEnd(),
   let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
    label = json["label"] as? String ?? label
    offsetX = CGFloat(json["offsetX"] as? Double ?? Double(offsetX))
    offsetY = CGFloat(json["offsetY"] as? Double ?? Double(offsetY))
}

class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSPanel!
    var resultSent = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let mouseLocation = NSEvent.mouseLocation
        let spawnX = mouseLocation.x + offsetX
        let spawnY = mouseLocation.y - windowHeight - offsetY

        window = NSPanel(
            contentRect: NSRect(x: spawnX, y: spawnY, width: windowWidth, height: windowHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        window.level = .mainMenu + 1
        window.isFloatingPanel = true
        window.isMovableByWindowBackground = false
        window.backgroundColor = .windowBackgroundColor
        window.hasShadow = true
        window.delegate = self
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.appearance = NSAppearance(named: .vibrantDark)
        window.alphaValue = 0.98

        let mainButton = NSButton(title: label, target: self, action: #selector(invokeAction))
        mainButton.frame = NSRect(
            x: outerMargin,
            y: outerMargin,
            width: windowWidth - closeButtonWidth - outerMargin * 2,
            height: windowHeight - outerMargin * 2
        )
        mainButton.bezelStyle = .rounded
        mainButton.isBordered = false
        mainButton.wantsLayer = true
        mainButton.layer?.backgroundColor = NSColor.controlAccentColor.cgColor
        mainButton.contentTintColor = .white

        let closeButton = NSButton(title: "×", target: self, action: #selector(skipAction))
        closeButton.frame = NSRect(
            x: windowWidth - closeButtonWidth - outerMargin,
            y: outerMargin,
            width: closeButtonWidth,
            height: windowHeight - outerMargin * 2
        )
        closeButton.bezelStyle = .rounded
        closeButton.isBordered = false
        closeButton.contentTintColor = .secondaryLabelColor

        window.contentView?.addSubview(mainButton)
        window.contentView?.addSubview(closeButton)
        window.makeKeyAndOrderFront(nil)

        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) {
            [weak self] event in
            if event.window != self?.window {
                self?.dismissAction()
            }
            return event
        }
    }

    @objc func invokeAction() {
        sendResult("invoke")
    }

    @objc func skipAction() {
        sendResult("skip")
    }

    func dismissAction() {
        sendResult("dismiss")
    }

    func sendResult(_ action: String) {
        guard !resultSent else { return }
        resultSent = true
        print("{\"action\":\"\(action)\"}")
        fflush(stdout)
        NSApplication.shared.terminate(nil)
    }

    func windowDidResignKey(_ notification: Notification) {
        dismissAction()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()

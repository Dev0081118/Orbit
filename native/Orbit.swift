import Cocoa
import WebKit

final class OrbitDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var service: Process?
    var startupTimer: Timer?
    let address = URL(string: "http://127.0.0.1:3210")!
    let root = Bundle.main.bundleURL.deletingLastPathComponent()
    func applicationDidFinishLaunching(_ notification: Notification) {
        makeMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1380, height: 860), styleMask: [.titled,.closable,.miniaturizable,.resizable,.fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Orbit"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unified
        window.backgroundColor = NSColor(calibratedWhite: 0.065, alpha: 1)
        window.minSize = NSSize(width: 760, height: 600)
        window.center()
        window.isReleasedWhenClosed = false
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "orbit")
        web = WKWebView(frame: window.contentView!.bounds, configuration: config)
        web.autoresizingMask = [.width,.height]
        web.uiDelegate = self
        web.navigationDelegate = self
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        web.setValue(false, forKey: "drawsBackground")
        web.loadHTMLString("<html><body style='background:#111211;color:#f1f1ef;font:14px -apple-system;padding:88px'><h1 style='font-weight:520'>Orbit</h1><p style='color:#a4a5a2'>Starting your coding workspace…</p></body></html>", baseURL: nil)
        probe { ready in
            if ready { self.web.load(URLRequest(url: self.address)) }
            else { self.startService() }
        }
    }
    func probe(_ completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: address.appendingPathComponent("api/health"))
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let value = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String:Any] }
            DispatchQueue.main.async { completion(value?["app"] as? String == "orbit-local") }
        }.resume()
    }
    func startService() {
        let binaries = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        guard let node = binaries.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else { showError("Node.js 24 or newer is required. Install it from nodejs.org, then reopen Orbit."); return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [root.appendingPathComponent("scripts/start.mjs").path]
        process.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env["ORBIT_NO_OPEN"] = "1"
        process.environment = env
        let data = root.appendingPathComponent("data")
        try? FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        let log = data.appendingPathComponent("desktop.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        if let handle = try? FileHandle(forWritingTo: log) { handle.seekToEndOfFile(); process.standardOutput = handle; process.standardError = handle }
        do { try process.run(); service = process } catch { showError(error.localizedDescription); return }
        var attempts = 0
        startupTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { timer in
            attempts += 1
            self.probe { ready in
                if ready { timer.invalidate(); self.startupTimer = nil; self.web.load(URLRequest(url: self.address)) }
                else if attempts > 90 { timer.invalidate(); self.startupTimer = nil; self.showError("The local engine did not start. Open Launch.command for diagnostics or inspect data/desktop.log.") }
            }
        }
    }
    func showError(_ message: String) {
        let alert = NSAlert(); alert.messageText = "Orbit could not start"; alert.informativeText = message; alert.addButton(withTitle: "OK"); alert.runModal()
    }
    func applicationWillTerminate(_ notification: Notification) { startupTimer?.invalidate(); if service?.isRunning == true { service?.terminate() } }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func makeMenu() {
        let menu = NSMenu(); let appItem = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Orbit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); appItem.submenu = appMenu; menu.addItem(appItem)
        let editItem = NSMenuItem(); editItem.title = "Edit"; let edit = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo","undo:","z"),("Cut","cut:","x"),("Copy","copy:","c"),("Paste","paste:","v"),("Select All","selectAll:","a")] { edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key) }
        editItem.submenu = edit; menu.addItem(editItem)
        let viewItem = NSMenuItem(); viewItem.title = "View"; let view = NSMenu(title: "View"); let reload = NSMenuItem(title:"Reload",action:#selector(reloadPage),keyEquivalent:"r"); reload.target=self;view.addItem(reload);viewItem.submenu=view;menu.addItem(viewItem)
        NSApp.mainMenu = menu
    }
    @objc func reloadPage() { web.reload() }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "orbit", let body = message.body as? [String: Any], body["type"] as? String == "chooseFolder" else { return }
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false; panel.prompt = "Choose Workspace"
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let path = panel.url?.path,
                  let data = try? JSONSerialization.data(withJSONObject: ["path": path]),
                  let json = String(data: data, encoding: .utf8) else { return }
            self.web.evaluateJavaScript("window.dispatchEvent(new CustomEvent('orbit-folder-selected',{detail:\(json)}))")
        }
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) { let a=NSAlert();a.messageText=message;a.addButton(withTitle:"OK");a.beginSheetModal(for:window){_ in completionHandler()} }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) { let a=NSAlert();a.messageText=message;a.addButton(withTitle:"Confirm");a.addButton(withTitle:"Cancel");a.beginSheetModal(for:window){response in completionHandler(response == .alertFirstButtonReturn)} }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) { let a=NSAlert();a.messageText=prompt;let field=NSTextField(frame:NSRect(x:0,y:0,width:320,height:24));field.stringValue=defaultText ?? "";a.accessoryView=field;a.addButton(withTitle:"Save");a.addButton(withTitle:"Cancel");a.beginSheetModal(for:window){response in completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)} }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) { let panel=NSOpenPanel();panel.allowsMultipleSelection=parameters.allowsMultipleSelection;panel.canChooseDirectories=false;panel.beginSheetModal(for:window){response in completionHandler(response == .OK ? panel.urls : nil)} }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        guard let url=action.request.url else { decisionHandler(.cancel);return }
        if url.host == "127.0.0.1" && url.port == 3210 || url.scheme == "about" || url.scheme == "blob" { decisionHandler(.allow) }
        else { if ["https","http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) };decisionHandler(.cancel) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme ?? ""), url.host != "127.0.0.1" { NSWorkspace.shared.open(url) }
        return nil
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate=self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate=self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) { let panel=NSSavePanel();panel.nameFieldStringValue=suggestedFilename;panel.beginSheetModal(for:window){result in completionHandler(result == .OK ? panel.url : nil)} }
}
let application = NSApplication.shared
let delegate = OrbitDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()

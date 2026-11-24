// 唱歌学日语 — macOS 外壳
// 一个原生窗口（系统自带的 WebKit，不需要 Chrome），加上打包在 App 里的 Node.js 跑本地服务。
// 窗口关掉就退出（连同后台服务），不常驻内存。
// 编译：tools/build-app.sh
import AppKit
import WebKit

let PORT = ProcessInfo.processInfo.environment["PORT"].flatMap(Int.init) ?? 3939
let BASE = "http://127.0.0.1:\(PORT)"
let RESTART_CODE: Int32 = 75 // 服务端「原地重启」用的退出码（见 server/index.js）

let resources = Bundle.main.resourceURL!
let appDir = resources.appendingPathComponent("app")
let nodeBin = resources.appendingPathComponent("node")
let dataDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
  .appendingPathComponent("唱歌学日语")

// ---------- 本地 HTTP 小工具 ----------
func request(_ path: String, method: String = "GET", timeout: TimeInterval = 1.5) async -> [String: Any]? {
  var req = URLRequest(url: URL(string: BASE + path)!, timeoutInterval: timeout)
  req.httpMethod = method
  if method != "GET" { req.setValue("application/json", forHTTPHeaderField: "Content-Type"); req.httpBody = Data("{}".utf8) }
  guard let (data, resp) = try? await URLSession.shared.data(for: req),
        (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
  return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

// ---------- 后台服务（Node） ----------
final class Server {
  var process: Process?
  var quitting = false
  var onExit: (() -> Void)?

  func start() {
    try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
    let p = Process()
    p.executableURL = nodeBin
    p.arguments = [appDir.appendingPathComponent("server/index.js").path]
    p.currentDirectoryURL = appDir
    var env = ProcessInfo.processInfo.environment
    env["PORT"] = String(PORT)
    env["UTA_DATA"] = dataDir.path
    env["UTA_NO_SHORTCUT"] = "1" // 不在桌面生成图标：App 本身就是入口
    env["UTA_APP"] = "1"
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin" + (env["PATH"].map { ":" + $0 } ?? "")
    p.environment = env
    let log = dataDir.appendingPathComponent("app.log")
    if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil) }
    if let h = try? FileHandle(forWritingTo: log) { h.seekToEndOfFile(); p.standardOutput = h; p.standardError = h }
    p.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async {
        guard let self, !self.quitting else { return }
        if proc.terminationStatus == RESTART_CODE { self.start() } // 「重启」：换上新代码再起来
        else { self.onExit?() } // 在设置里点了「退出」，或服务出错退出：整个 App 跟着退出
      }
    }
    do { try p.run(); process = p } catch { NSLog("启动服务失败：\(error)"); onExit?() }
  }

  func stop() {
    quitting = true
    guard let p = process, p.isRunning else { return }
    p.terminate()
    let deadline = Date().addingTimeInterval(1.5)
    while p.isRunning && Date() < deadline { usleep(50_000) }
    if p.isRunning { kill(p.processIdentifier, SIGKILL) }
  }
}

// ---------- 窗口 ----------
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var web: WKWebView!
  let server = Server()

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default() // 界面偏好存在 localStorage 里，要留下来
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.setValue(false, forKey: "drawsBackground") // 载入前不闪白
    if #available(macOS 13.3, *) { web.isInspectable = true }

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                      backing: .buffered, defer: false)
    window.title = "唱歌学日语"
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.backgroundColor = NSColor(red: 0.114, green: 0.102, blue: 0.149, alpha: 1) // 和界面的底色一样
    window.minSize = NSSize(width: 640, height: 480)
    window.contentView = web
    window.center()
    window.setFrameAutosaveName("main")
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)

    web.loadHTMLString("""
      <html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#1d1a26;color:#bbb;font:15px -apple-system">
      正在启动…</body></html>
      """, baseURL: nil)

    server.onExit = { NSApp.terminate(nil) }
    Task { await boot() }
  }

  // 端口上已经有一份在跑（比如以前从终端启动的）：不是这个 App 里的就让它退出，换成自己的
  func boot() async {
    if let info = await request("/api/info") {
      if (info["root"] as? String) != appDir.path {
        _ = await request("/api/quit", method: "POST")
        for _ in 0..<20 { if await request("/api/info", timeout: 0.3) == nil { break }; try? await Task.sleep(nanoseconds: 200_000_000) }
        await MainActor.run { server.start() }
      }
    } else {
      await MainActor.run { server.start() }
    }
    for _ in 0..<150 { // 最多等 30 秒
      if await request("/api/info", timeout: 0.5) != nil {
        _ = await MainActor.run { web.load(URLRequest(url: URL(string: BASE + "/?app=1")!)) }
        return
      }
      try? await Task.sleep(nanoseconds: 200_000_000)
    }
    _ = await MainActor.run {
      web.loadHTMLString("<body style='background:#1d1a26;color:#ddd;font:15px -apple-system;padding:40px'>本地服务没有启动起来。日志在：\(dataDir.path)/app.log</body>", baseURL: nil)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
  func applicationWillTerminate(_ note: Notification) { server.stop() }

  // 页面里的 window.close()（退出程序时）
  func webViewDidClose(_ webView: WKWebView) { window.close() }

  // 本机以外的链接（词典网站等）交给默认浏览器打开
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload { return decisionHandler(.download) }
    if let url = action.request.url, let host = url.host, !["127.0.0.1", "localhost"].contains(host) {
      NSWorkspace.shared.open(url)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }
  func webView(_ webView: WKWebView, createWebViewWith c: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }
  // 「导出 CSV」这类下载：存到「下载」文件夹并在访达里选中
  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
    let disp = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    decisionHandler(disp.lowercased().contains("attachment") || !response.canShowMIMEType ? .download : .allow)
  }
  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
  var lastDownload: URL?
  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    let name = suggestedFilename as NSString
    var url = dir.appendingPathComponent(suggestedFilename)
    var n = 2
    while FileManager.default.fileExists(atPath: url.path) {
      url = dir.appendingPathComponent("\(name.deletingPathExtension) \(n).\(name.pathExtension)"); n += 1
    }
    lastDownload = url
    completionHandler(url)
  }
  func downloadDidFinish(_ download: WKDownload) {
    if let u = lastDownload { NSWorkspace.shared.activateFileViewerSelecting([u]) }
  }

  // ---------- 菜单：退出、复制粘贴、重新载入、全屏 ----------
  @objc func reload() { web.reload() }
  func buildMenu() {
    let main = NSMenu()
    func sub(_ title: String, _ items: [NSMenuItem]) {
      let m = NSMenu(title: title); items.forEach(m.addItem)
      let it = NSMenuItem(); it.submenu = m; main.addItem(it)
    }
    func item(_ t: String, _ a: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i
    }
    sub("唱歌学日语", [
      item("隐藏唱歌学日语", #selector(NSApplication.hide(_:)), "h"),
      .separator(),
      item("退出唱歌学日语", #selector(NSApplication.terminate(_:)), "q"),
    ])
    sub("编辑", [
      item("撤销", Selector(("undo:")), "z"),
      item("重做", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("剪切", #selector(NSText.cut(_:)), "x"),
      item("拷贝", #selector(NSText.copy(_:)), "c"),
      item("粘贴", #selector(NSText.paste(_:)), "v"),
      item("全选", #selector(NSText.selectAll(_:)), "a"),
    ])
    let reloadItem = item("重新载入", #selector(reload), "r"); reloadItem.target = self
    sub("显示", [reloadItem, item("进入全屏幕", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])])
    sub("窗口", [
      item("最小化", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("关闭", #selector(NSWindow.performClose(_:)), "w"),
    ])
    NSApp.mainMenu = main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()

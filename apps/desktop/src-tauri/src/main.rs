// Prevent a console window from opening behind the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Emil Accounting Pro — the till, as a Windows application.
//!
//! ---------------------------------------------------------------------------
//! THIS SHELL DELIBERATELY BUNDLES NO APPLICATION CODE.
//!
//! The obvious Tauri design is to compile the Next.js app to static files and
//! ship them inside the binary. This does the opposite: the window points at
//! the shop server the deployment already runs. Four things fall out of that,
//! and each is a problem that would otherwise need solving:
//!
//!  1. `http://localhost` IS A SECURE CONTEXT. `crypto.randomUUID` generates
//!     the `Idempotency-Key` on every financial write, and it is absent on a
//!     plain-HTTP LAN origin — a bug that has already reached a real till here.
//!     Pointing at the server the browser already uses keeps that fixed.
//!  2. NO CORS. `apps/api` has none, on purpose: the browser calls `/api/*` on
//!     the web origin and Next proxies inward. Same origin, so it stays true.
//!  3. NO SECOND BUILD MODE. The static export is welded to the demo backend
//!     (`NEXT_PUBLIC_DEMO=1`), and prising them apart to bundle the real app
//!     would mean a third build nobody exercises.
//!  4. ONE SERVER, MANY DEVICES. The cashier PC, the owner's phone and a tablet
//!     read one set of books. Bundling a database per till would quietly end
//!     that, and nothing would announce it until two devices disagreed.
//!
//! So the only thing compiled in is the connection screen below — shown when
//! the server cannot be reached, because the alternative is a blank white
//! window and a queue at the counter.
//!
//! THE REMOTE ORIGIN GETS NO IPC. Commands are invoked only from the bundled
//! connection page. Once the window navigates to the server, the page is
//! ordinary web content with no access to the filesystem or the OS — which is
//! the correct blast radius for a page served over a shop LAN.
//! ---------------------------------------------------------------------------

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Where the till looks for the shop server.
///
/// `localhost` and not the LAN address, deliberately: on the machine running
/// the stack it is a secure context, and on a machine that is not, the operator
/// sets the address once on the connection screen. See
/// `docs/HYBRID-SHOP-DEPLOYMENT.md` §3.
const DEFAULT_SERVER_URL: &str = "http://localhost:8080";

/// Long enough for a cold Docker stack to answer, short enough that a cashier
/// does not think the application has hung.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Settings {
    #[serde(rename = "serverUrl")]
    server_url: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self { server_url: DEFAULT_SERVER_URL.to_string() }
    }
}

/// `%APPDATA%\com.emil.accounting\settings.json` on Windows.
///
/// Beside the app's own data rather than in the install directory: Program Files
/// is not writable by a standard user, and a till is exactly where the person
/// using it is not an administrator.
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config directory: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir.join("settings.json"))
}

fn read_settings(app: &tauri::AppHandle) -> Settings {
    // Any failure here falls back to the default rather than refusing to start.
    // A corrupt settings file must not be the reason a shop cannot sell; the
    // connection screen lets the operator retype the address in seconds.
    settings_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
        .unwrap_or_default()
}

#[tauri::command]
fn get_server_url(app: tauri::AppHandle) -> String {
    read_settings(&app).server_url
}

#[tauri::command]
fn save_server_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return Err("The server address cannot be empty.".into());
    }
    let path = settings_path(&app)?;
    let body = serde_json::to_string_pretty(&Settings { server_url: trimmed })
        .map_err(|e| format!("cannot serialise settings: {e}"))?;
    fs::write(&path, body).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// Is the shop server answering?
///
/// Hand-rolled over `TcpStream` rather than through an HTTP crate, and the
/// reason is in Cargo.toml: the client that would send this one request is what
/// drags a C cross-compiler into the build. One GET, one status line, no
/// dependency.
///
/// `/api/openapi.json` rather than `/`: it is unauthenticated, and it is served
/// by the API *through* the web container's proxy — so a 200 proves the whole
/// chain is up. A 200 from `/` would only prove the web container is running,
/// which is the half that is never the problem.
///
/// An `https://` address degrades to "did the port accept a connection". That
/// is a weaker claim, said plainly here rather than papered over — and it does
/// not matter in practice, because the till talks to the shop server over plain
/// HTTP on the LAN and must never route through Tailscale.
#[tauri::command]
async fn probe_server(url: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || probe_blocking(&url))
        .await
        .unwrap_or(false)
}

fn probe_blocking(raw: &str) -> bool {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};

    let Ok(parsed) = url::Url::parse(raw.trim_end_matches('/')) else {
        return false;
    };
    let Some(host) = parsed.host_str() else { return false };
    let secure = parsed.scheme() == "https";
    let port = parsed.port().unwrap_or(if secure { 443 } else { 80 });

    // Resolve and connect with a deadline. `to_socket_addrs` can block on a
    // hostname, which is why the whole probe runs off the UI thread.
    let Ok(mut addrs) = (host, port).to_socket_addrs() else { return false };
    let Some(addr) = addrs.next() else { return false };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) else {
        return false;
    };

    // Nothing here speaks TLS, so an https address stops at "the port answered".
    if secure {
        return true;
    }

    let _ = stream.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(PROBE_TIMEOUT));

    let request = format!(
        "GET /api/openapi.json HTTP/1.1\r\nHost: {host}:{port}\r\n\
         User-Agent: emil-desktop\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    // The status line is all that is needed, so read a small fixed chunk rather
    // than the whole OpenAPI document — which is large, and would make a health
    // check the biggest transfer the app performs.
    let mut head = [0u8; 128];
    let Ok(read) = stream.read(&mut head) else { return false };
    let status = String::from_utf8_lossy(&head[..read]);
    status.starts_with("HTTP/1.1 200") || status.starts_with("HTTP/1.0 200")
}

/// Point the existing window at the shop server.
///
/// Navigating rather than opening a second window: the session lives in
/// `localStorage`, and two windows against one session would both hold the same
/// refresh token. Rotation treats a replayed refresh token as theft and revokes
/// the entire family — so a second window does not merely duplicate the app, it
/// signs the cashier out mid-sale.
#[tauri::command]
fn open_app(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    let parsed = url
        .trim_end_matches('/')
        .parse()
        .map_err(|e| format!("not a usable address: {e}"))?;
    window.navigate(parsed).map_err(|e| format!("could not open {url}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::probe_blocking;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// A one-shot server that answers with `status` and then goes away.
    fn serve_once(status: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut scratch = [0u8; 1024];
                let _ = stream.read(&mut scratch);
                let _ = stream.write_all(
                    format!("{status}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}")
                        .as_bytes(),
                );
            }
        });
        port
    }

    #[test]
    fn a_200_means_the_whole_chain_is_up() {
        let port = serve_once("HTTP/1.1 200 OK");
        assert!(probe_blocking(&format!("http://127.0.0.1:{port}")));
    }

    #[test]
    fn a_trailing_slash_is_not_a_different_address() {
        // The connection screen trims these, but the stored value predates that
        // trimming on any machine upgraded from an earlier build.
        let port = serve_once("HTTP/1.1 200 OK");
        assert!(probe_blocking(&format!("http://127.0.0.1:{port}/")));
    }

    #[test]
    fn a_404_is_not_a_working_server() {
        // Something is listening on the port, which is exactly the case a bare
        // TCP connect would call healthy: the web container up with the API
        // behind it down. The whole reason the probe asks for a real document.
        let port = serve_once("HTTP/1.1 404 Not Found");
        assert!(!probe_blocking(&format!("http://127.0.0.1:{port}")));
    }

    #[test]
    fn a_closed_port_is_not_a_working_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener); // nothing is listening now
        assert!(!probe_blocking(&format!("http://127.0.0.1:{port}")));
    }

    #[test]
    fn rubbish_is_refused_rather_than_panicking() {
        assert!(!probe_blocking("not a url"));
        assert!(!probe_blocking(""));
        assert!(!probe_blocking("http://"));
    }
}

fn main() {
    tauri::Builder::default()
        // A double-click on the taskbar icon must raise the window that is
        // already open, for the localStorage reason in `open_app` above.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_server_url,
            save_server_url,
            probe_server,
            open_app
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let settings = read_settings(&handle);

            // Probe BEFORE deciding what to load. Opening the server URL first
            // and reacting to a failure afterwards shows the operator a browser
            // error page — which tells a cashier nothing they can act on.
            let reachable = tauri::async_runtime::block_on(probe_server(settings.server_url.clone()));

            let target = if reachable {
                WebviewUrl::External(
                    settings
                        .server_url
                        .parse()
                        .expect("a stored server URL that already answered a probe"),
                )
            } else {
                WebviewUrl::App("index.html".into())
            };

            WebviewWindowBuilder::new(app, "main", target)
                .title("Emil Accounting Pro")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 600.0)
                .resizable(true)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Emil Accounting Pro");
}

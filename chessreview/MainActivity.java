package com.teleagent.chessreview;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * 棋局评价 —— chess.com 风格棋局复盘应用。
 * UI 层为 WebView(chess.com 风格前端)；引擎层为原生 Stockfish 进程；
 * 本类承担：引擎进程管理、JS 桥接、NNUE 模型管理、应用自动更新、PGN 文件读写。
 */
public class MainActivity extends Activity implements Downloader.Callback {

    private static final String TAG = "ChessReview";
    private static final int REQ_PGN_OPEN = 1001;
    private static final int REQ_PGN_SAVE = 1002;

    private WebView webView;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private StockfishEngine engine;
    private SharedPreferences prefs;
    private File modelsDir;
    private final Downloader downloader = new Downloader();

    private String engineName = "";
    private boolean engineReadySent = false;
    private boolean engineDefaultsApplied = false;

    // 引擎输出行缓冲（批量投递给 JS，避免高频 evaluateJavascript 卡顿）
    private final Object lineLock = new Object();
    private final ArrayList<String> lineQueue = new ArrayList<>();
    private boolean flushScheduled = false;

    // 应用更新（系统 DownloadManager）
    private long updateDmId = -1;
    private BroadcastReceiver updateReceiver = null;
    private boolean updateReceiverRegistered = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("chessreview", MODE_PRIVATE);
        modelsDir = new File(getFilesDir(), "models");
        ensureModelsFromAssets();
        downloader.setCallback(this);
        setupWebView();
        handleSendIntent(getIntent());
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void setupWebView() {
        webView = new WebView(this);
        setContentView(webView);
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        ws.setLoadWithOverviewMode(true);
        ws.setUseWideViewPort(true);
        ws.setSupportZoom(false);
        ws.setDisplayZoomControls(false);
        ws.setMediaPlaybackRequiresUserGesture(false);
        webView.setBackgroundColor(0xFF312E2B);
        webView.addJavascriptInterface(new Bridge(), "Android");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, "[js] " + m.message() + " @" + m.lineNumber());
                return true;
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url != null && (url.startsWith("http://") || url.startsWith("https://"))) {
                    openExternal(url);
                    return true;
                }
                return false;
            }
        });
        webView.loadUrl("file:///android_asset/www/index.html");
    }

    // ------------------------------------------------------------------
    // 生命周期

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleSendIntent(intent);
    }

    @Override
    protected void onDestroy() {
        unregisterUpdateReceiver();
        if (engine != null) engine.shutdown();
        super.onDestroy();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 暂停时收缩引擎算力，避免后台耗电（停止当前搜索）
        if (engine != null && engine.isAlive()) engine.send("stop");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            if (requestCode == REQ_PGN_OPEN) js("window.Bridge&&window.Bridge.pgnLoaded(null)");
            return;
        }
        Uri uri = data.getData();
        if (requestCode == REQ_PGN_OPEN) {
            try {
                String text = readUriText(uri);
                js("window.Bridge&&window.Bridge.pgnLoaded(" + quote(text) + ")");
            } catch (Exception e) {
                js("window.Bridge&&window.Bridge.pgnLoaded(null," + quote("读取文件失败: " + e.getMessage()) + ")");
            }
        } else if (requestCode == REQ_PGN_SAVE) {
            try {
                writeUriText(uri, pendingSaveContent);
                js("window.Bridge&&window.Bridge.pgnSaved(true," + quote(uri.getLastPathSegment() == null ? "" : uri.getLastPathSegment()) + ")");
            } catch (Exception e) {
                js("window.Bridge&&window.Bridge.pgnSaved(false," + quote(String.valueOf(e.getMessage())) + ")");
            }
            pendingSaveContent = null;
        }
    }

    private String pendingSaveContent = null;

    private void handleSendIntent(Intent intent) {
        if (intent == null) return;
        if (Intent.ACTION_SEND.equals(intent.getAction())
                && "text/plain".equals(intent.getType())) {
            String text = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (text != null && text.length() > 0) {
                final String payload = text;
                ui.postDelayed(new Runnable() {
                    @Override public void run() {
                        js("window.Bridge&&window.Bridge.pgnShared(" + quote(payload) + ")");
                    }
                }, 800); // 等前端初始化完成
            }
        }
    }

    // ------------------------------------------------------------------
    // 引擎

    /** 返回本机可用的引擎可执行文件路径（lib/<abi>/libstockfish.so 由安装器解出并可执行）。 */
    private String pickEngineBinary() {
        try {
            String dir = getApplicationInfo().nativeLibraryDir;
            File f = new File(dir, "libstockfish.so");
            if (f.exists() && f.canExecute()) return f.getAbsolutePath();
        } catch (Throwable ignored) {}
        return null;
    }

    private boolean startEngine() {
        if (engine != null && engine.isAlive()) return true;
        engineReadySent = false;
        engineDefaultsApplied = false;
        engineName = "";
        String binary = pickEngineBinary();
        if (binary == null) {
            String abis = abiList();
            js("window.Bridge&&window.Bridge.engineFailed(" + quote(
                    "未找到适用于本机 CPU 的 Stockfish 引擎（当前架构: " + abis + "，支持 arm64/armv7）") + ")");
            return false;
        }
        engine = new StockfishEngine();
        boolean ok = engine.start(binary, getFilesDir(), new StockfishEngine.Listener() {
            @Override
            public void onLine(String line) {
                handleEngineLine(line);
            }

            @Override
            public void onExit(int code) {
                final int c = code;
                ui.post(new Runnable() {
                    @Override public void run() {
                        js("window.Bridge&&window.Bridge.engineDied(" + c + ")");
                    }
                });
            }
        });
        if (!ok) {
            js("window.Bridge&&window.Bridge.engineFailed(" + quote("引擎进程启动失败") + ")");
            return false;
        }
        engine.send("uci");
        return true;
    }

    private void handleEngineLine(String line) {
        if (line == null || line.length() == 0) return;
        synchronized (lineLock) { lineQueue.add(line); }
        try {
            if (line.startsWith("id name ")) {
                engineName = line.substring(8).trim();
            } else if (line.equals("uciok")) {
                applyEngineDefaults();
            } else if (line.equals("readyok")) {
                if (!engineReadySent) {
                    engineReadySent = true;
                    notifyEngineReady();
                }
            } else if (line.contains("CRITICAL ERROR")) {
                Log.e(TAG, "engine critical: " + line);
            }
        } catch (Throwable ignored) {}
        scheduleFlush();
    }

    /** uciok 后设置默认引擎参数，然后 isready 完成握手。 */
    private void applyEngineDefaults() {
        if (engineDefaultsApplied || engine == null) return;
        engineDefaultsApplied = true;
        int cores = Runtime.getRuntime().availableProcessors();
        int threads = Math.max(1, Math.min(6, cores - 1));
        int hash = prefInt("engineHash", 128);
        String evalFile = defaultModelPath();
        if (evalFile != null) engine.send("setoption name EvalFile value " + evalFile);
        engine.send("setoption name Threads value " + threads);
        engine.send("setoption name Hash value " + hash);
        engine.send("setoption name MultiPV value 2");
        engine.send("isready");
    }

    private void notifyEngineReady() {
        try {
            JSONObject info = new JSONObject();
            info.put("name", engineName.isEmpty() ? "Stockfish" : engineName);
            info.put("cores", Runtime.getRuntime().availableProcessors());
            info.put("abi", abiList());
            info.put("sdkInt", Build.VERSION.SDK_INT);
            info.put("appVersion", appVersion());
            info.put("model", activeModelName());
            js("window.Bridge&&window.Bridge.engineReady(" + info.toString() + ")");
        } catch (Throwable t) {
            Log.e(TAG, "notifyReady", t);
        }
    }

    /** 批量把引擎输出行投递给 JS。 */
    private void scheduleFlush() {
        synchronized (lineLock) {
            if (flushScheduled) return;
            flushScheduled = true;
        }
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                ArrayList<String> batch;
                synchronized (lineLock) {
                    batch = new ArrayList<>(lineQueue);
                    lineQueue.clear();
                    flushScheduled = false;
                }
                if (batch.isEmpty()) return;
                StringBuilder sb = new StringBuilder("window.Bridge&&window.Bridge.engineLines([");
                for (int i = 0; i < batch.size(); i++) {
                    if (i > 0) sb.append(',');
                    sb.append(quote(batch.get(i)));
                }
                sb.append("])");
                final String expr = sb.toString();
                if (webView != null) {
                    webView.post(new Runnable() {
                        @Override public void run() {
                            if (webView != null) webView.evaluateJavascript(expr, null);
                        }
                    });
                }
            }
        }, 60);
    }

    // ------------------------------------------------------------------
    // NNUE 模型管理

    private void ensureModelsFromAssets() {
        try {
            modelsDir.mkdirs();
            String[] names = getAssets().list("models");
            if (names != null) {
                for (String n : names) {
                    File f = new File(modelsDir, n);
                    if (!f.exists()) copyAsset("models/" + n, f);
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "copy assets models: " + t);
        }
    }

    private void copyAsset(String assetPath, File dest) throws Exception {
        InputStream in = getAssets().open(assetPath);
        OutputStream out = new FileOutputStream(dest);
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        out.flush();
        out.close();
        in.close();
    }

    private List<File> listModels() {
        List<File> out = new ArrayList<>();
        File[] files = modelsDir.listFiles();
        if (files != null) {
            for (File f : files) {
                String n = f.getName();
                if (f.isFile() && n.endsWith(".nnue")) out.add(f);
            }
        }
        return out;
    }

    private String activeModelName() {
        String m = prefs.getString("activeModel", "");
        if (m.isEmpty()) {
            List<File> files = listModels();
            if (!files.isEmpty()) return files.get(0).getName();
            return "";
        }
        return m;
    }

    private String defaultModelPath() {
        String name = activeModelName();
        if (name.isEmpty()) return null;
        File f = new File(modelsDir, name);
        return f.exists() ? f.getAbsolutePath() : null;
    }

    // ------------------------------------------------------------------
    // 应用更新

    private void checkUpdate(final String manifestUrl) {
        new Thread(new Runnable() {
            @Override public void run() {
                HttpURLConnection conn = null;
                try {
                    conn = (HttpURLConnection) new URL(manifestUrl).openConnection();
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(20000);
                    conn.setInstanceFollowRedirects(true);
                    conn.setRequestProperty("User-Agent", "ChessReview/" + appVersion());
                    int code = conn.getResponseCode();
                    if (code >= 400) throw new Exception("HTTP " + code);
                    InputStream in = conn.getInputStream();
                    byte[] buf = new byte[8192];
                    int n; StringBuilder sb = new StringBuilder();
                    while ((n = in.read(buf)) > 0) sb.append(new String(buf, 0, n, "UTF-8"));
                    in.close();
                    JSONObject m = new JSONObject(sb.toString());
                    long remote = m.optLong("versionCode", -1);
                    String remoteName = m.optString("versionName", "");
                    PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
                    long cur = (Build.VERSION.SDK_INT >= 28) ? pi.getLongVersionCode()
                            : (long) pi.versionCode;
                    JSONObject res = new JSONObject();
                    res.put("ok", true);
                    res.put("hasUpdate", remote > cur);
                    res.put("versionCode", remote);
                    res.put("versionName", remoteName);
                    res.put("apkUrl", m.optString("apkUrl", ""));
                    res.put("sha256", m.optString("sha256", ""));
                    res.put("notes", m.optString("notes", ""));
                    res.put("currentVersion", appVersion());
                    res.put("currentVersionCode", cur);
                    js("window.Bridge&&window.Bridge.updateInfo(" + res.toString() + ")");
                } catch (Throwable e) {
                    try {
                        JSONObject res = new JSONObject();
                        res.put("ok", false);
                        res.put("error", String.valueOf(e.getMessage()));
                        js("window.Bridge&&window.Bridge.updateInfo(" + res.toString() + ")");
                    } catch (Throwable ignored) {}
                } finally {
                    if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) {}
                }
            }
        }, "update-check").start();
    }

    /** 通过系统下载器下载更新 APK（可断点续传、有系统通知），完成后自动引导安装。 */
    private void installFromUrl(String apkUrl) {
        try {
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(apkUrl));
            req.setMimeType("application/vnd.android.package-archive");
            req.setTitle("棋局评价 更新包");
            req.setDescription(apkUrl);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "ChessReview-update.apk");
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setAllowedOverMetered(true);
            req.setAllowedOverRoaming(true);
            registerUpdateReceiver();
            updateDmId = dm.enqueue(req);
            toast("开始下载更新包（见系统通知）");
        } catch (Throwable t) {
            toast("下载失败: " + t.getMessage());
        }
    }

    private void registerUpdateReceiver() {
        if (updateReceiverRegistered) return;
        updateReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != updateDmId) return;
                DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                DownloadManager.Query q = new DownloadManager.Query();
                q.setFilterById(id);
                android.database.Cursor cur = dm.query(q);
                if (cur != null && cur.moveToFirst()) {
                    int status = cur.getInt(cur.getColumnIndex(DownloadManager.COLUMN_STATUS));
                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        Uri uri = dm.getUriForDownloadedFile(id);
                        if (uri != null) promptInstall(uri);
                    } else if (status == DownloadManager.STATUS_FAILED) {
                        toast("更新包下载失败");
                    }
                }
                if (cur != null) cur.close();
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(updateReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(updateReceiver, filter);
        }
        updateReceiverRegistered = true;
    }

    private void unregisterUpdateReceiver() {
        if (updateReceiverRegistered) {
            try { unregisterReceiver(updateReceiver); } catch (Throwable ignored) {}
            updateReceiverRegistered = false;
        }
    }

    private void promptInstall(Uri uri) {
        if (Build.VERSION.SDK_INT >= 26
                && !getPackageManager().canRequestPackageInstalls()) {
            js("window.Bridge&&window.Bridge.needInstallPermission()");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            toast("无法启动安装器");
        }
    }

    private void openInstallPermissionSettings() {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
            toast("请允许“安装未知应用”后再次安装");
        } catch (Throwable t) {
            toast("无法打开设置: " + t.getMessage());
        }
    }

    // ------------------------------------------------------------------
    // 工具

    private String appVersion() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionName;
        } catch (Throwable t) {
            return "?";
        }
    }

    private String abiList() {
        if (Build.VERSION.SDK_INT >= 21 && Build.SUPPORTED_ABIS != null) {
            StringBuilder sb = new StringBuilder();
            for (String a : Build.SUPPORTED_ABIS) {
                if (sb.length() > 0) sb.append(',');
                sb.append(a);
            }
            return sb.toString();
        }
        return Build.CPU_ABI;
    }

    private int prefInt(String key, int def) {
        try { return Integer.parseInt(prefs.getString(key, String.valueOf(def))); }
        catch (Throwable t) { return def; }
    }

    private void toast(final String msg) {
        ui.post(new Runnable() {
            @Override public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
            }
        });
    }

    /** 在主线程执行 JS 片段。 */
    private void js(final String expr) {
        ui.post(new Runnable() {
            @Override public void run() {
                if (webView != null) webView.evaluateJavascript(expr, null);
            }
        });
    }

    private static String quote(String s) {
        if (s == null) s = "";
        return org.json.JSONObject.quote(s);
    }

    private String readUriText(Uri uri) throws Exception {
        InputStream in = getContentResolver().openInputStream(uri);
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        return new String(bos.toByteArray(), "UTF-8");
    }

    private void writeUriText(Uri uri, String text) throws Exception {
        OutputStream out = getContentResolver().openOutputStream(uri, "w");
        out.write(text.getBytes("UTF-8"));
        out.flush();
        out.close();
    }

    private void openExternal(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            toast("没有可打开链接的应用");
        }
    }

    private void shareText(String subject, String text) {
        try {
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType("text/plain");
            i.putExtra(Intent.EXTRA_SUBJECT, subject);
            i.putExtra(Intent.EXTRA_TEXT, text);
            startActivity(Intent.createChooser(i, "分享"));
        } catch (Throwable t) {
            toast("分享失败");
        }
    }

    // ------------------------------------------------------------------
    // 下载器回调 → 转发 JS

    @Override
    public void onProgress(final int id, final long done, final long total) {
        js("window.Bridge&&window.Bridge.downloadProgress(" + id + "," + done + "," + total + ")");
    }

    @Override
    public void onDone(final int id, final boolean ok, final String pathOrError) {
        js("window.Bridge&&window.Bridge.downloadDone(" + id + "," + ok + "," + quote(pathOrError) + ")");
    }

    // ------------------------------------------------------------------
    // JS 桥接（window.Android）

    private class Bridge {

        @JavascriptInterface
        public String appVersion() { return appVersion(); }

        @JavascriptInterface
        public int androidSdk() { return Build.VERSION.SDK_INT; }

        @JavascriptInterface
        public String abiList() { return MainActivity.this.abiList(); }

        @JavascriptInterface
        public int cpuCores() { return Runtime.getRuntime().availableProcessors(); }

        @JavascriptInterface
        public void toast(String msg) { MainActivity.this.toast(msg); }

        @JavascriptInterface
        public String prefGet(String key) {
            return prefs.getString(key, "");
        }

        @JavascriptInterface
        public void prefSet(String key, String value) {
            prefs.edit().putString(key, value == null ? "" : value).apply();
        }

        @JavascriptInterface
        public boolean engineStart() { return startEngine(); }

        @JavascriptInterface
        public boolean engineAlive() { return engine != null && engine.isAlive(); }

        @JavascriptInterface
        public void engineSend(String cmd) {
            if (engine != null) engine.send(cmd);
        }

        @JavascriptInterface
        public void engineSet(String name, String value) {
            if (engine != null) engine.send("setoption name " + name + " value " + value);
        }

        @JavascriptInterface
        public void engineStop() {
            if (engine != null) engine.send("stop");
        }

        @JavascriptInterface
        public String engineName() { return engineName; }

        @JavascriptInterface
        public String modelsList() {
            try {
                JSONArray arr = new JSONArray();
                String active = activeModelName();
                for (File f : listModels()) {
                    JSONObject o = new JSONObject();
                    o.put("name", f.getName());
                    o.put("size", f.length());
                    o.put("active", f.getName().equals(active));
                    arr.put(o);
                }
                return arr.toString();
            } catch (Throwable t) {
                return "[]";
            }
        }

        @JavascriptInterface
        public int download(String url, String fileName, String sha256) {
            File dest = new File(modelsDir, fileName);
            return downloader.start(url, dest, sha256);
        }

        @JavascriptInterface
        public void downloadCancel(int id) { downloader.cancel(id); }

        @JavascriptInterface
        public boolean modelActivate(String fileName) {
            try {
                File f = new File(modelsDir, fileName);
                if (!f.exists()) return false;
                if (engine != null && engine.isAlive()) {
                    engine.send("setoption name EvalFile value " + f.getAbsolutePath());
                    engine.send("isready");
                }
                prefs.edit().putString("activeModel", fileName).apply();
                return true;
            } catch (Throwable t) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean modelDelete(String fileName) {
            try {
                String active = activeModelName();
                if (fileName.equals(active)) return false; // 正在使用的模型不可删除
                File f = new File(modelsDir, fileName);
                return f.delete();
            } catch (Throwable t) {
                return false;
            }
        }

        @JavascriptInterface
        public void checkUpdate(String manifestUrl) {
            MainActivity.this.checkUpdate(manifestUrl);
        }

        @JavascriptInterface
        public void installFromUrl(String apkUrl) {
            MainActivity.this.installFromUrl(apkUrl);
        }

        @JavascriptInterface
        public void openInstallPermissionSettings() {
            MainActivity.this.openInstallPermissionSettings();
        }

        @JavascriptInterface
        public void openUrl(String url) {
            MainActivity.this.openExternal(url);
        }

        @JavascriptInterface
        public void shareText(String subject, String text) {
            MainActivity.this.shareText(subject, text);
        }

        @JavascriptInterface
        public void pgnPick() {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                    "application/x-chess-pgn", "text/plain", "application/octet-stream", "*/*"});
            try {
                startActivityForResult(i, REQ_PGN_OPEN);
            } catch (Throwable t) {
                toast("无法打开文件选择器");
            }
        }

        @JavascriptInterface
        public void pgnSave(String suggestedName, String content) {
            pendingSaveContent = content;
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("application/x-chess-pgn");
            i.putExtra(Intent.EXTRA_TITLE, suggestedName == null || suggestedName.isEmpty()
                    ? "game-review.pgn" : suggestedName);
            try {
                startActivityForResult(i, REQ_PGN_SAVE);
            } catch (Throwable t) {
                pendingSaveContent = null;
                toast("无法保存文件");
            }
        }
    }
}

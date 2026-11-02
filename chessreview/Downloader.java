package com.teleagent.chessreview;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 通用 HTTP 下载器（用于 NNUE 模型等小文件），带进度与 SHA-256 校验。
 * 进度/结果回调统一投递到主线程，由 MainActivity 转发给 WebView。
 */
class Downloader {

    interface Callback {
        void onProgress(int id, long done, long total);
        void onDone(int id, boolean ok, String pathOrError);
    }

    private final AtomicInteger ids = new AtomicInteger(1);
    private final ConcurrentHashMap<Integer, Boolean> cancelled = new ConcurrentHashMap<>();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Callback callback;

    void setCallback(Callback cb) { this.callback = cb; }

    boolean isCancelled(int id) { return Boolean.TRUE.equals(cancelled.get(id)); }

    /** 返回任务 id。dest 为目标文件（先写 .part 再改名）。sha256hex 可为 null。 */
    int start(final String url, final File dest, final String sha256hex) {
        final int id = ids.getAndIncrement();
        cancelled.put(id, Boolean.FALSE);
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                File part = new File(dest.getAbsolutePath() + ".part");
                HttpURLConnection conn = null;
                try {
                    dest.getParentFile().mkdirs();
                    if (dest.exists()) dest.delete();
                    if (part.exists()) part.delete();
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(60000);
                    conn.setInstanceFollowRedirects(true);
                    conn.setRequestProperty("User-Agent", "ChessReview/1.0");
                    int code = conn.getResponseCode();
                    if (code >= 400) throw new Exception("HTTP " + code);
                    long total = conn.getContentLength();
                    InputStream in = conn.getInputStream();
                    MessageDigest md = (sha256hex != null && sha256hex.length() >= 32)
                            ? MessageDigest.getInstance("SHA-256") : null;
                    FileOutputStream out = new FileOutputStream(part);
                    byte[] buf = new byte[65536];
                    long done = 0;
                    long lastCb = 0;
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (isCancelled(id)) throw new Exception("已取消");
                        out.write(buf, 0, n);
                        if (md != null) md.update(buf, 0, n);
                        done += n;
                        long now = System.currentTimeMillis();
                        if (now - lastCb > 400) {
                            lastCb = now;
                            postProgress(id, done, total);
                        }
                    }
                    out.flush();
                    out.close();
                    in.close();
                    if (total > 0 && done != total) throw new Exception("下载不完整");
                    if (md != null) {
                        String hex = toHex(md.digest());
                        if (!hex.equalsIgnoreCase(sha256hex)) throw new Exception("SHA-256 校验失败");
                    }
                    if (!part.renameTo(dest)) throw new Exception("写入目标文件失败");
                    postDone(id, true, dest.getAbsolutePath());
                } catch (Throwable e) {
                    try { part.delete(); } catch (Throwable ignored) {}
                    postDone(id, false, String.valueOf(e.getMessage()));
                } finally {
                    if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) {}
                }
            }
        }, "dl-" + id);
        t.setDaemon(true);
        t.start();
        return id;
    }

    void cancel(int id) { cancelled.put(id, Boolean.TRUE); }

    private void postProgress(final int id, final long done, final long total) {
        final Callback cb = callback;
        if (cb == null) return;
        ui.post(new Runnable() {
            @Override public void run() {
                Callback c = callback;
                if (c != null) c.onProgress(id, done, total);
            }
        });
    }

    private void postDone(final int id, final boolean ok, final String msg) {
        ui.post(new Runnable() {
            @Override public void run() {
                Callback c = callback;
                if (c != null) c.onDone(id, ok, msg);
            }
        });
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format(Locale.US, "%02x", b));
        return sb.toString();
    }
}

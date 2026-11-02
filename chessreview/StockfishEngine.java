package com.teleagent.chessreview;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 原生 Stockfish 引擎进程封装（UCI 协议管道）。
 * 引擎二进制位于 nativeLibraryDir/libstockfish.so（由 APK 的 lib/<abi>/ 解出，具备可执行权限）。
 */
class StockfishEngine {

    interface Listener {
        void onLine(String line);
        void onExit(int code);
    }

    private Process process;
    private BufferedWriter writer;
    private Thread readerThread;
    private final AtomicBoolean alive = new AtomicBoolean(false);
    private volatile Listener listener;

    /** 启动引擎进程。cwd 建议传 filesDir，便于相对路径 NNUE 解析。 */
    boolean start(String binary, File cwd, Listener l) {
        listener = l;
        try {
            ProcessBuilder pb = new ProcessBuilder(binary);
            if (cwd != null && cwd.isDirectory()) pb.directory(cwd);
            pb.redirectErrorStream(true);
            process = pb.start();
            writer = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), "UTF-8"));
            alive.set(true);
            readerThread = new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        BufferedReader br = new BufferedReader(
                                new InputStreamReader(process.getInputStream(), "UTF-8"));
                        String line;
                        while ((line = br.readLine()) != null) {
                            Listener ls = listener;
                            if (ls != null) {
                                try { ls.onLine(line); } catch (Throwable ignored) {}
                            }
                        }
                    } catch (IOException ignored) {
                    }
                    alive.set(false);
                    int code = 0;
                    try { code = process.waitFor(); } catch (InterruptedException ignored) {}
                    Listener ls = listener;
                    if (ls != null) {
                        try { ls.onExit(code); } catch (Throwable ignored) {}
                    }
                }
            }, "sf-reader");
            readerThread.setDaemon(true);
            readerThread.start();
            return true;
        } catch (Throwable t) {
            alive.set(false);
            return false;
        }
    }

    /** 向引擎发送一条 UCI 命令（线程安全）。 */
    synchronized void send(String cmd) {
        if (!alive.get() || writer == null) return;
        try {
            writer.write(cmd);
            writer.write("\n");
            writer.flush();
        } catch (IOException e) {
            alive.set(false);
        }
    }

    boolean isAlive() {
        return alive.get() && process != null;
    }

    void shutdown() {
        send("quit");
        try {
            if (process != null) process.destroy();
        } catch (Throwable ignored) {}
        alive.set(false);
    }
}

// scraping-mcp-server/src/server.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import express from 'express';
import type { Request, Response } from 'express';
import { z } from "zod";
import { execFile, ExecFileException } from "node:child_process";
import { promisify } from "node:util";
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import dotenv from 'dotenv';
import fs from 'node:fs';

dotenv.config();
const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_YOURSCRAPINGAPP_EXE_PATH = path.resolve(projectRoot, 'bin', 'YourScrapingApp.exe');
const YOURSCRAPINGAPP_EXE_PATH = process.env.YOURSCRAPINGAPP_EXE_PATH || DEFAULT_YOURSCRAPINGAPP_EXE_PATH;
console.log(`[MCP Server Config] Using YourScrapingApp.exe path: ${YOURSCRAPINGAPP_EXE_PATH}`);
const YOURSCRAPINGAPP_EXE_DIR = path.dirname(YOURSCRAPINGAPP_EXE_PATH);
console.log(`[MCP Server Config] Setting YourScrapingApp.exe working directory to: ${YOURSCRAPINGAPP_EXE_DIR}`);

if (fs.existsSync(YOURSCRAPINGAPP_EXE_PATH)) { console.log(`[MCP Server Debug] EXE Path EXISTS: ${YOURSCRAPINGAPP_EXE_PATH}`); }
else { console.error(`[MCP Server Debug] EXE Path DOES NOT EXIST: ${YOURSCRAPINGAPP_EXE_PATH}`); }
if (fs.existsSync(YOURSCRAPINGAPP_EXE_DIR)) {
    console.log(`[MCP Server Debug] EXE Dir EXISTS: ${YOURSCRAPINGAPP_EXE_DIR}`);
    try {
        const filesInExeDir = fs.readdirSync(YOURSCRAPINGAPP_EXE_DIR);
        console.log(`[MCP Server Debug] Files in EXE Dir (${YOURSCRAPINGAPP_EXE_DIR}):`, filesInExeDir.slice(0,10).concat(filesInExeDir.length > 10 ? ['...'] : []));
    } catch (e) { console.error(`[MCP Server Debug] Could not read EXE Dir: ${YOURSCRAPINGAPP_EXE_DIR}`, e); }
} else { console.error(`[MCP Server Debug] EXE Dir DOES NOT EXIST: ${YOURSCRAPINGAPP_EXE_DIR}`); }

const EXECUTION_TIMEOUT = 600000;
const MCP_SERVER_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : 3001;

// --- Zodスキーマ定義 ---
const crawlWebsiteInputSchema = z.object({
    url: z.string().url({ message: "Invalid URL format for starting crawl." }).describe("The starting URL for crawling (must be a valid URL)."),
    selector: z.string().min(1, { message: "CSS selector cannot be empty." }).describe("CSS selector for links to follow (e.g., 'a', '.content a')."),
    max_depth: z.number().int().positive().optional().describe("Maximum crawl depth from the start URL. If not provided, task default will be used."),
    parallel: z.number().int().positive().optional().describe("Maximum number of parallel browser tasks. If not provided, task default will be used."),
    timeout: z.number().int().positive().optional().describe("Operation timeout in milliseconds for page loads/actions. If not provided, task default will be used."),
    apply_stealth: z.boolean().optional().describe("Whether to apply playwright-stealth for evasion. If not provided, task default will be used."),
    headless_mode: z.boolean().optional().describe("Whether to run the browser in headless mode. If not specified, the task's default behavior is used."),
    ignore_robots_txt: z.boolean().optional().describe("Whether to ignore the website's robots.txt file. If not provided, task default will be used."),
    user_agent: z.string().optional().describe("Custom user agent string to use for crawling. If not provided, task default will be used."),
    request_delay: z.number().nonnegative().optional().describe("Delay in seconds between requests. If not provided, task default will be used."),
    no_samedomain: z.boolean().optional().describe("If true, allows crawling to external domains. If false or not provided, restricts to the same domain as the start URL."),
    // ★★★ 新しいプロパティを追加 ★★★
    main_content_only: z.boolean().optional().describe("If true, the crawler will attempt to identify the main content of a page and only follow links within that area, ignoring headers, footers, and sidebars.")
});

const getGoogleAiSummaryInputSchema = z.object({
    query: z.string().min(1, { message: "Search query cannot be empty." }).describe("The search query string for Google."),
    headless_mode: z.boolean().optional().describe("Whether to run the browser in headless mode. If not specified, the task's default behavior is used."),
    wait_seconds: z.number().int().positive().optional().describe("Time in seconds to wait and display results in headed mode. If not provided, task default will be used.")
});

const scrapeLawPageInputSchema = z.object({
    url: z.string().url({ message: "Invalid URL format for the law page." }).describe("The URL of the law page to scrape."),
    keyword: z.string().min(1, { message: "Search keyword cannot be empty." }).describe("The keyword to search for within the law text."),
    wait_selector: z.string().optional().describe("CSS selector to wait for before parsing. If not provided, task default will be used."),
    headless_mode: z.boolean().optional().describe("Whether to run the browser in headless mode. If not specified, the task's default behavior is used."),
    timeout: z.number().int().positive().optional().describe("Operation timeout in milliseconds for page loads/actions. If not provided, task default will be used."),
    browser_type: z.enum(["chromium", "firefox", "webkit"]).optional().describe("The type of browser to use for scraping. If not provided, task default (usually 'chromium') will be used."),
    context_window: z.number().int().positive().optional().describe("Number of characters before and after the keyword to include in the snippet. If not provided, task default will be used."),
    merge_threshold: z.number().int().positive().optional().describe("Threshold distance between keyword occurrences to merge snippets. If not provided, task default will be used.")
});

// ★★★ 新規追加: google_search ツールのスキーマ ★★★
const googleSearchInputSchema = z.object({
    query: z.string().min(1, { message: "Search query cannot be empty." }).describe("The search query string for Google."),
    search_pages: z.number().int().positive().optional().describe("Number of search result pages to process. Defaults to 1 if not provided."),
    parallel: z.number().int().positive().optional().describe("Maximum number of parallel browser tasks for scraping result pages. If not provided, task default will be used."),
    timeout: z.number().int().positive().optional().describe("Operation timeout in milliseconds for page loads/actions. If not provided, task default will be used."),
    headless_mode: z.boolean().optional().describe("Whether to run the browser in headless mode. If not specified, the task's default behavior is used."),
});
// ★★★ ここまで ★★★

async function runYourScrapingAppTool(
    taskName: string,
    params: Record<string, any>
): Promise<CallToolResult> {
    console.log(`[MCP Server Tool][${taskName}] Tool called with params:`, JSON.stringify(params, null, 2));
    const args: string[] = ["--task", taskName, "--output-stdout-json"];

    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (key === "output_stdout_json") continue;

        let argName = "";
        let argValue = String(value);
        let pushArgWithValue = true;

        // ★★★ 変更箇所: search_pages のマッピングを追加 ★★★
        switch (key) {
            // --- フラグ系の引数 (値を取らない、または --no- で反転) ---
            case "headless_mode":
                if (value === true) args.push("--headless");
                // `main_app.py`の`argparse`は`--headless`がない場合デフォルトでFalseになるため、
                // falseの場合に明示的に引数を送る必要はない
                pushArgWithValue = false;
                break;
            case "apply_stealth":
                if (value === true) args.push("--stealth");
                pushArgWithValue = false;
                break;
            case "no_samedomain":
                if (value === true) args.push("--no-samedomain");
                pushArgWithValue = false;
                break;
            case "ignore_robots_txt":
                if (value === true) args.push("--ignore_robots_txt");
                pushArgWithValue = false;
                break;
            // ★★★ 新しい引数のマッピングを追加 ★★★
            case "main_content_only":
                if (value === true) args.push("--main-content-only");
                pushArgWithValue = false;
                break;

            // --- 値を取る引数 (exe のヘルプに合わせる) ---
            case "max_depth":         argName = "--max_depth"; break;
            case "request_delay":     argName = "--request_delay"; break;
            case "user_agent":        argName = "--user_agent"; break;
            case "wait_seconds":      argName = "--wait"; break;
            case "wait_selector":     argName = "--wait_selector"; break;
            case "browser_type":      argName = "--browser_type"; break;
            case "context_window":    argName = "--context_window"; break;
            case "merge_threshold":   argName = "--merge_threshold"; break;
            case "search_pages":      argName = "--search-pages"; break; // ★★★ 新規追加 ★★★

            // Zodのキー名とexeの引数名が一致しているもの
            case "url":
            case "selector":
            case "parallel":
            case "timeout":
            case "query":
            case "keyword":
                argName = `--${key}`;
                break;
            default:
                console.warn(`[MCP Server Tool][${taskName}] Unhandled key to argName conversion for: ${key}. Defaulting to --${key.replace(/_/g, '-')}`);
                argName = `--${key.replace(/_/g, '-')}`;
        }
        // ★★★ ここまで ★★★

        if (pushArgWithValue && argName) {
            args.push(argName, argValue);
        }
    }

    const absoluteExePath = path.resolve(YOURSCRAPINGAPP_EXE_PATH);
    const absoluteCwd = path.resolve(YOURSCRAPINGAPP_EXE_DIR);

    const commandToLog = `"${absoluteExePath}" ${args.map(arg => arg.includes(" ") ? `"${arg}"` : arg).join(' ')}`;
    console.log(`[MCP Server Tool][${taskName}] Executing: ${commandToLog}`);
    console.log(`[MCP Server Tool][${taskName}] CWD: "${absoluteCwd}"`);

    try {
        const { stdout, stderr } = await execFileAsync(absoluteExePath, args, {
            timeout: EXECUTION_TIMEOUT,
            encoding: 'buffer',
            cwd: absoluteCwd,
            windowsHide: true
        });

        const stdoutString = stdout.toString('utf-8').trim();
        const stderrString = stderr.toString('utf-8').trim();

        if (stderrString) {
            console.warn(`[MCP Server Tool][${taskName}] YourScrapingApp.exe stderr:\n--- STDERR ---\n${stderrString}\n------------`);
        }
        if (stdoutString) {
            console.log(`[MCP Server Tool][${taskName}] YourScrapingApp.exe stdout (decoded, length: ${stdoutString.length}):\n--- STDOUT (first 1000 chars) ---\n${stdoutString.substring(0, 1000)}${stdoutString.length > 1000 ? '...' : ''}\n------------`);
        } else {
            console.log(`[MCP Server Tool][${taskName}] YourScrapingApp.exe produced empty stdout after decoding and trimming.`);
        }

        if (!stdoutString) {
            const errorMsg = `Error: Task '${taskName}' process produced no output after decoding. Stderr (if any): ${stderrString || '(empty)'}`;
            console.error(`[MCP Server Tool][${taskName}] ${errorMsg}`);
            return { isError: true, content: [{ type: "text", text: errorMsg }] };
        }

        let resultData: any;
        try {
            resultData = JSON.parse(stdoutString);
            console.log(`[MCP Server Tool][${taskName}] Successfully parsed decoded stdout as JSON.`);
        } catch (parseError: any) {
            const errorMsg = `Error: Could not parse task '${taskName}' decoded output as JSON. Raw (first 500 chars of decoded):\n${stdoutString.substring(0, 500)}`;
            console.error(`[MCP Server Tool][${taskName}] JSON parsing error: ${parseError.message}. ${errorMsg}`, parseError);
            return { isError: true, content: [{ type: "text", text: errorMsg }] };
        }

        if (resultData && typeof resultData === 'object' && resultData !== null) {
            // main_app.pyが返すJSONの構造をチェック
            // 1. エラーを報告しているか (status != 'success')
            // 2. 成功を報告しているか (status == 'success')
            // 3. 上記statusフィールドがないか (直接データが出力されたとみなす)
            if ('status' in resultData && resultData.status !== "success") {
                const errorMessage = resultData.message || `Task '${taskName}' reported status: ${resultData.status}`;
                console.warn(`[MCP Server Tool][${taskName}] Task reported error via status field: ${errorMessage}`);
                return { isError: true, content: [{ type: "text", text: JSON.stringify(resultData) }] }; // エラー詳細を含めて返す
            } else if (resultData.status === "success") {
                 // 成功の場合、'task_output_data' を探す
                 const taskOutput = resultData.task_output_data;
                 if (taskOutput) {
                    console.log(`[MCP Server Tool][${taskName}] Task successful, returning task_output_data.`);
                    return { content: [{ type: "text", text: JSON.stringify(taskOutput) }] };
                 } else {
                     console.warn(`[MCP Server Tool][${taskName}] Task reported status:success but no 'task_output_data' found. Returning full result.`);
                     return { content: [{ type: "text", text: JSON.stringify(resultData) }] };
                 }
            } else {
                // statusフィールドがない場合、全体を成功データとみなす
                console.log(`[MCP Server Tool][${taskName}] Task successful, received direct data output (no status field).`);
                return { content: [{ type: "text", text: JSON.stringify(resultData) }] };
            }
        } else {
            const unexpectedDataMsg = `Error: Task '${taskName}' output parsed to an unexpected value (not an object or null). Parsed as: ${typeof resultData}`;
            console.error(`[MCP Server Tool][${taskName}] ${unexpectedDataMsg} Data:`, resultData);
            return { isError: true, content: [{ type: "text", text: unexpectedDataMsg }] };
        }

    } catch (error: any) {
        console.error(`[MCP Server Tool][${taskName}] Error executing YourScrapingApp.exe:`, error);
        let detailedErrorMsg = `Failed to execute task '${taskName}'.`;
        if (error.message) detailedErrorMsg += ` Message: ${error.message}`;
        const execError = error as ExecFileException & { stdout?: string | Buffer, stderr?: string | Buffer };
        if (execError.code !== undefined) detailedErrorMsg += ` Exit code: ${execError.code}.`;
        if (execError.signal !== undefined) detailedErrorMsg += ` Signal: ${execError.signal}.`;
        if (execError.stdout) {
            let execStdout = Buffer.isBuffer(execError.stdout) ? execError.stdout.toString('utf-8') : execError.stdout;
            if (execStdout) detailedErrorMsg += `\n--- Process STDOUT (during error) ---\n${execStdout}`;
        }
        if (execError.stderr) {
            let execStderr = Buffer.isBuffer(execError.stderr) ? execError.stderr.toString('utf-8') : execError.stderr;
            if (execStderr) detailedErrorMsg += `\n--- Process STDERR (during error) ---\n${execStderr}`;
        }
        return { isError: true, content: [{ type: "text", text: detailedErrorMsg }] };
    }
}

function setupMcpServer(): McpServer {
    console.log("[MCP Server Init] Initializing Scraping MCP Server...");
    const server = new McpServer({ name: "ScrapingToolsServer", version: "1.0.0" });
    console.log("[MCP Server Init] Server instance created.");
    
    // 既存のツール
    server.tool("crawl_website", "指定されたURLからウェブサイトをクロールし、リンク、メールアドレス、電話番号などの情報を収集します。最大深度や同一ドメイン制限などのオプションを指定できます。", crawlWebsiteInputSchema.shape, async (params) => runYourScrapingAppTool("crawl", params));
    console.log("[MCP Server Tool] 'crawl_website' tool defined.");
    
    server.tool("get_google_ai_summary", "指定された検索クエリでGoogle検索を実行し、AIによる概要の参照元URLを全件取得します。SEO分析などに特化しています。", getGoogleAiSummaryInputSchema.shape, async (params) => runYourScrapingAppTool("google_ai", params));
    console.log("[MCP Server Tool] 'get_google_ai_summary' tool defined.");

    server.tool("scrape_law_page", "指定された法令ページのURLから特定のキーワードを検索し、キーワードが出現する条文や関連する階層情報（章、節など）を含む文脈を抽出します。", scrapeLawPageInputSchema.shape, async (params) => runYourScrapingAppTool("law_scraper", params));
    console.log("[MCP Server Tool] 'scrape_law_page' tool defined.");

    // ★★★ 新規追加: google_search ツール ★★★
    server.tool(
        "google_search",
        "指定された検索クエリでGoogle検索を実行し、AIによる概要と通常の検索結果の両方を取得します。さらに、それらの結果ページのURLにアクセスして、本文コンテンツ、メールアドレス、電話番号を収集します。",
        googleSearchInputSchema.shape,
        async (params) => runYourScrapingAppTool("google_search", params)
    );
    console.log("[MCP Server Tool] 'google_search' tool defined.");
    // ★★★ ここまで ★★★

    return server;
}

async function startHttpServer() {
    const app = express();
    app.use(express.json());
    console.log(`[HTTP Server] Setting up /mcp endpoint on port ${MCP_SERVER_PORT}...`);
    
    app.post('/mcp', async (req: Request, res: Response) => {
        console.log('[HTTP Server] Received POST /mcp request');
        console.debug(`[HTTP Server] Body: ${JSON.stringify(req.body, null, 2)}`);
        
        let transport: StreamableHTTPServerTransport | null = null;
        let mcpServerInstance: McpServer | null = null;
        try {
            mcpServerInstance = setupMcpServer();
            transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            res.on('close', () => { 
                console.log('[HTTP Server] Client connection closed. Cleaning up...'); 
                if (transport) transport.close(); 
                if (mcpServerInstance) mcpServerInstance.close(); 
            });
            await mcpServerInstance.connect(transport);
            console.log('[HTTP Server] McpServer connected to transport.');
            await transport.handleRequest(req, res, req.body);
            console.log('[HTTP Server] Handled POST /mcp request via transport.');
        } catch (error) {
            console.error('[HTTP Server] Error handling POST /mcp request:', error);
            const requestId = (typeof req.body === 'object' && req.body && 'id' in req.body) ? req.body.id : null;
            if (!res.headersSent) { res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error during MCP processing.' }, id: requestId }); }
            else { console.error("[HTTP Server] Headers already sent, cannot send 500 error response."); }
            if (transport) transport.close(); 
            if (mcpServerInstance) mcpServerInstance.close();
        }
    });

    app.get('/mcp', (req: Request, res: Response) => { 
        console.log('[HTTP Server] GET /mcp (Not Allowed for Stateless).'); 
        res.status(405).set('Allow', 'POST').json({ jsonrpc: "2.0", error: { code: -32601, message: "Method Not Allowed. Use POST." }, id: null });
    });

    const httpServer = http.createServer(app);
    httpServer.listen(MCP_SERVER_PORT, () => {
        console.log("==========================================================");
        console.log(` Scraping MCP Server is running (Stateless HTTP Mode) `);
        console.log(` Listening for POST requests on http://localhost:${MCP_SERVER_PORT}/mcp `);
        console.log(` -> Invoking YourScrapingApp.exe from: ${YOURSCRAPINGAPP_EXE_PATH}`);
        console.log("==========================================================");
        console.log("Waiting for client connections...");
    });

    const shutdown = (signal: string) => {
        console.log(`\n[System] ${signal} received. Shutting down...`);
        httpServer.close((err?: Error) => {
            if (err) { console.error("[System] HTTP server shutdown error:", err); process.exit(1); }
            else { console.log("[System] HTTP server closed."); process.exit(0); }
        });
        setTimeout(() => { console.error("[System] Graceful shutdown timeout. Forcefully exiting."); process.exit(1); }, 10000);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startHttpServer().catch(error => {
    console.error("[System] Failed to start HTTP server:", error);
    process.exit(1);
});
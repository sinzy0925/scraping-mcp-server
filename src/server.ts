// scraping-mcp-server/src/server.ts

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolResult, TextContent } from "@modelcontextprotocol/sdk/types.js";
import express from 'express';
import type { Request, Response } from 'express';
import { z } from "zod";
import { execFile, ExecFileException } from "node:child_process"; // ExecFileException をインポート
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
    no_samedomain: z.boolean().optional().describe("If true, allows crawling to external domains. If false or not provided, restricts to the same domain as the start URL.")
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

async function runYourScrapingAppTool(
    taskName: string,
    params: Record<string, any>
): Promise<CallToolResult> {
    console.log(`[MCP Server Tool][${taskName}] Tool called with params:`, params);
    const args: string[] = ["--task", taskName, "--output-stdout-json"];

    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (key === "output_stdout_json") continue;

        let argName = `--${key.replace(/_/g, '-')}`;

        if (key === "headless_mode") {
            if (value === true) { args.push("--headless"); }
            else if (value === false) { args.push("--no-headless"); }
            continue;
        }
        if (key === "apply_stealth") {
            if (value === true) { args.push("--stealth"); }
            else if (value === false) { args.push("--no-stealth"); }
            continue;
        }
        if (key === "no_samedomain" || key === "ignore_robots_txt") {
            if (value === true) { args.push(argName); }
            continue;
        }
        if (key === "wait_seconds") argName = "--wait";
        if (key === "browser_type") argName = "--browser-type";
        if (key === "context_window") argName = "--context-window";
        if (key === "merge_threshold") argName = "--merge-threshold";

        args.push(argName, String(value));
    }

    const absoluteExePath = path.resolve(YOURSCRAPINGAPP_EXE_PATH);
    const absoluteCwd = path.resolve(YOURSCRAPINGAPP_EXE_DIR);

    const commandToLog = `"${absoluteExePath}" ${args.map(arg => arg.includes(" ") ? `"${arg}"` : arg).join(' ')}`;
    console.log(`[MCP Server Tool][${taskName}] Executing: ${commandToLog}`);
    console.log(`[MCP Server Tool][${taskName}] CWD: "${absoluteCwd}"`);

    try {
        // encoding: 'buffer' を指定することで、stdout と stderr が Buffer として返されます。
        // これにより、TypeScript は stdout と stderr を Buffer 型として正しく推論します。
        const { stdout, stderr } = await execFileAsync(absoluteExePath, args, {
            timeout: EXECUTION_TIMEOUT,
            encoding: 'buffer', // ★ 修正: encoding を 'buffer' に設定
            cwd: absoluteCwd,
            windowsHide: true
        });
        // 上記の修正により、以下の型アサーションは不要になります。
        // }) as { stdout: Buffer, stderr: Buffer };

        // stdout と stderr は Buffer 型なので、toString() を使って文字列に変換します。
        const stdoutString = stdout.toString('utf-8').trim();
        const stderrString = stderr.toString('utf-8').trim();

        if (stderrString) {
            console.warn(`[MCP Server Tool][${taskName}] YourScrapingApp.exe stderr:\n--- STDERR ---\n${stderrString}\n------------`);
        }
        if (stdoutString) {
            console.log(`[MCP Server Tool][${taskName}] YourScrapingApp.exe stdout (decoded, length: ${stdoutString.length}):\n--- STDOUT ---\n${stdoutString}\n------------`);
        } else {
            console.log(`[MCP Server Tool][${taskName}] YourScrapingApp.exe produced empty stdout after decoding and trimming.`);
        }

        if (!stdoutString) {
            const errorMsg = `Error: Task '${taskName}' process produced no output after decoding.`;
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
            if (resultData.status && resultData.status !== "success") {
                const errorMessage = resultData.message || `Task '${taskName}' reported status: ${resultData.status}`;
                console.warn(`[MCP Server Tool][${taskName}] Task reported error via status field: ${errorMessage}`);
                return { isError: true, content: [{ type: "text", text: errorMessage }] };
            } else if (resultData.status === "success") {
                 if (resultData.details && resultData.details.task_output_data) {
                    console.log(`[MCP Server Tool][${taskName}] Task successful (via status field), using task_output_data from details.`);
                    return { content: [{ type: "text", text: JSON.stringify(resultData.details.task_output_data) }] };
                 } else if (resultData.details) {
                    console.log(`[MCP Server Tool][${taskName}] Task successful (via status field), using details as content.`);
                     return { content: [{ type: "text", text: JSON.stringify(resultData.details) }] };
                 } else {
                     console.warn(`[MCP Server Tool][${taskName}] Task reported status:success but no 'details' or 'task_output_data' found. Returning full resultData.`);
                     return { content: [{ type: "text", text: JSON.stringify(resultData) }] };
                 }
            } else {
                console.log(`[MCP Server Tool][${taskName}] Task successful, received direct data output (no status field).`);
                return { content: [{ type: "text", text: JSON.stringify(resultData) }] };
            }
        } else {
            const unexpectedDataMsg = `Error: Task '${taskName}' output parsed to an unexpected value (not an object or null).`;
            console.error(`[MCP Server Tool][${taskName}] ${unexpectedDataMsg} Data:`, resultData);
            return { isError: true, content: [{ type: "text", text: unexpectedDataMsg }] };
        }

    } catch (error: any) { // execFileAsync自体のエラー (ENOENTなど)
        console.error(`[MCP Server Tool][${taskName}] Error executing YourScrapingApp.exe:`, error);
        let detailedErrorMsg = `Failed to execute task '${taskName}'.`;
        if (error.message) detailedErrorMsg += ` Message: ${error.message}`;

        // error オブジェクトが ExecFileException のインスタンスか、または stdout/stderr プロパティを持つか確認
        // ExecFileException の stdout/stderr は string | Buffer の可能性があるため、両方に対応
        const execError = error as ExecFileException & { stdout?: string | Buffer, stderr?: string | Buffer };

        if (execError.code !== undefined) detailedErrorMsg += ` Exit code: ${execError.code}.`;
        if (execError.signal !== undefined) detailedErrorMsg += ` Signal: ${execError.signal}.`;

        if (execError.stdout) {
            let execStdout = '';
            if (Buffer.isBuffer(execError.stdout)) {
                execStdout = execError.stdout.toString('utf-8');
            } else if (typeof execError.stdout === 'string') {
                execStdout = execError.stdout;
            }
            if (execStdout) {
                detailedErrorMsg += `\n--- Process STDOUT (during error) ---\n${execStdout}`;
            }
        }
        if (execError.stderr) {
            let execStderr = '';
            if (Buffer.isBuffer(execError.stderr)) {
                execStderr = execError.stderr.toString('utf-8');
            } else if (typeof execError.stderr === 'string') {
                execStderr = execError.stderr;
            }
            if (execStderr) {
                detailedErrorMsg += `\n--- Process STDERR (during error) ---\n${execStderr}`;
            }
        }
        return { isError: true, content: [{ type: "text", text: detailedErrorMsg }] };
    }
}

function setupMcpServer(): McpServer {
    console.log("[MCP Server Init] Initializing Scraping MCP Server...");
    const server = new McpServer({ name: "ScrapingToolsServer", version: "1.0.0" });
    console.log("[MCP Server Init] Server instance created.");
    server.tool("crawl_website", "指定されたURLからウェブサイトをクロールし、リンク、メールアドレス、電話番号などの情報を収集します。最大深度や同一ドメイン制限などのオプションを指定できます。", crawlWebsiteInputSchema.shape, async (params) => runYourScrapingAppTool("crawl", params));
    console.log("[MCP Server Tool] 'crawl_website' tool defined.");
    server.tool("get_google_ai_summary", "指定された検索クエリでGoogle検索を実行し、AIによる概要と通常の検索結果（タイトルとURL）を取得します。", getGoogleAiSummaryInputSchema.shape, async (params) => runYourScrapingAppTool("google_ai", params));
    console.log("[MCP Server Tool] 'get_google_ai_summary' tool defined.");
    server.tool("scrape_law_page", "指定された法令ページのURLから特定のキーワードを検索し、キーワードが出現する条文や関連する階層情報（章、節など）を含む文脈を抽出します。", scrapeLawPageInputSchema.shape, async (params) => runYourScrapingAppTool("law_scraper", params));
    console.log("[MCP Server Tool] 'scrape_law_page' tool defined.");
    return server;
}

async function startHttpServer() {
    const app = express();
    app.use(express.json());
    console.log(`[HTTP Server] Setting up /mcp endpoint on port ${MCP_SERVER_PORT}...`);
    app.post('/mcp', async (req: Request, res: Response) => {
        console.log('[HTTP Server] Received POST /mcp request');
        console.debug(`[HTTP Server] Headers: ${JSON.stringify(req.headers, null, 2)}`);
        console.debug(`[HTTP Server] Body: ${JSON.stringify(req.body, null, 2)}`);
        let transport: StreamableHTTPServerTransport | null = null;
        let mcpServerInstance: McpServer | null = null;
        try {
            mcpServerInstance = setupMcpServer();
            transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            res.on('close', () => { console.log('[HTTP Server] Client connection closed. Cleaning up...'); if (transport) transport.close(); if (mcpServerInstance) mcpServerInstance.close(); });
            await mcpServerInstance.connect(transport);
            console.log('[HTTP Server] McpServer connected to transport.');
            await transport.handleRequest(req, res, req.body);
            console.log('[HTTP Server] Handled POST /mcp request via transport.');
        } catch (error) {
            console.error('[HTTP Server] Error handling POST /mcp request:', error);
            const requestId = (typeof req.body === 'object' && req.body && 'id' in req.body) ? req.body.id : null;
            if (!res.headersSent) { res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error during MCP processing.' }, id: requestId }); }
            else { console.error("[HTTP Server] Headers already sent, cannot send 500 error response."); }
            if (transport) transport.close(); if (mcpServerInstance) mcpServerInstance.close();
        }
    });
    app.get('/mcp', (req: Request, res: Response) => { console.log('[HTTP Server] GET /mcp (Not Allowed for Stateless).'); res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Allow': 'POST' }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Method Not Allowed. Use POST." }, id: null })); });
    app.delete('/mcp', (req: Request, res: Response) => { console.log('[HTTP Server] DELETE /mcp (Not Allowed for Stateless).'); res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Allow': 'POST' }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32601, message: "Method Not Allowed." }, id: null })); });
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
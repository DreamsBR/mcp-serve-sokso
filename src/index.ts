#!/usr/bin/env node
import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
import dotenv from "dotenv";
import fs from "fs";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { fromIni } from "@aws-sdk/credential-providers";
import { DateTime } from "luxon";
import path from "path";

// --- Configuration ---
const dotenvPath = process.env.DOTENV_PATH;
if (dotenvPath) {
  dotenv.config({ path: dotenvPath });
} else {
  dotenv.config();
}

// --- Logging ---
const LOG_FILE = path.join(process.cwd(), "mcp-server.log");
function log(msg: string) {
  const entry = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, entry);
  console.error(msg);
}

// --- Services ---
class PoolManager {
  private pools = new Map<string, pg.Pool>();
  private configs: Record<string, string> = {};

  constructor() {
    this.loadConfigs();
  }

  loadConfigs() {
    // Debug: Check if env vars are loaded
    console.log("DEBUG ENV VARS:", {
        FISIO: process.env.DB_FISIOTERAPIA_URL ? "SET" : "UNSET",
        PEDIDOS: process.env.DB_PEDIDOS_URL ? "SET" : "UNSET",
        PROD: process.env.DB_PEDIDOSPRODUCTION_URL ? "SET" : "UNSET"
    });

    const configPath = process.env.MCP_DB_CONFIG_PATH || "databases.json";
    if (fs.existsSync(configPath)) {
      try {
        const rawConfig = fs.readFileSync(configPath, "utf8");
        // Substitute ${VAR_NAME} with environment variables
        const substitutedConfig = rawConfig.replace(/\$\{(.+?)\}/g, (_, varName) => {
          return process.env[varName] || "";
        });
        this.configs = JSON.parse(substitutedConfig);
      } catch (error) {
        log(`Error loading database configs: ${error}`);
      }
    }

    // Load configs from ENV variables directly if not in databases.json
    if (process.env.DB_FISIOTERAPIA_URL && !this.configs["fisioterapia"]) {
        this.configs["fisioterapia"] = process.env.DB_FISIOTERAPIA_URL;
    }
    if (process.env.DB_PEDIDOS_URL && !this.configs["pedidos"]) {
        this.configs["pedidos"] = process.env.DB_PEDIDOS_URL;
    }
    if (process.env.DB_PEDIDOSPRODUCTION_URL && !this.configs["pedidosproduction"]) {
        this.configs["pedidosproduction"] = process.env.DB_PEDIDOSPRODUCTION_URL;
    }

    if (process.env.DB_HOST && !this.configs["default"]) {
      const connectionString = `postgresql://${process.env.DB_USER}:${
        process.env.DB_PASSWORD
      }@${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${
        process.env.DB_NAME
      }`;
      this.configs["default"] = connectionString;
    }
    
    // Log loaded configurations (masking passwords)
    log(`Loaded database configurations: ${Object.keys(this.configs).join(", ")}`);
  }

  async getPool(name = "default"): Promise<pg.Pool> {
    if (!this.pools.has(name)) {
      this.loadConfigs();
      const connectionString = this.configs[name]?.trim();
      if (!connectionString) {
        throw new Error(
          `Configuración '${name}' no encontrada. Disponibles: ${Object.keys(
            this.configs
          ).join(", ")}`
        );
      }

      const isLocal =
        connectionString.includes("localhost") ||
        connectionString.includes("127.0.0.1") ||
        connectionString.includes("postgres") || // Docker internal alias often used locally
        connectionString.includes("sslmode=disable");
        
      const forceSSL = (!isLocal && !connectionString.includes("sslmode=disable")) || connectionString.includes("sslmode=require");

      // FIX: If forceSSL is false, we must pass 'false' or undefined, NOT an object.
      // Passing { rejectUnauthorized: false } triggers SSL handshake which fails on non-SSL servers.
      const sslConfig = forceSSL ? { rejectUnauthorized: false } : undefined;

      const pool = new pg.Pool({
        connectionString,
        ssl: sslConfig,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 30000,
        max: 10,
      });

      this.pools.set(name, pool);
    }
    return this.pools.get(name)!;
  }
}

const poolManager = new PoolManager();

const cloudWatchClient = new CloudWatchLogsClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: fromIni({ profile: process.env.AWS_PROFILE || "default" }),
});

async function fetchAWSLogs(
  logGroupName: string,
  startTimeStr: string,
  endTimeStr: string,
  filterPattern?: string
) {
  const tz_peru = "America/Lima";
  const startDt = startTimeStr.includes("T") || startTimeStr.includes("Z")
    ? DateTime.fromISO(startTimeStr).setZone(tz_peru)
    : DateTime.fromFormat(startTimeStr, "yyyy-MM-dd HH:mm:ss", { zone: tz_peru });

  const endDt = endTimeStr.includes("T") || endTimeStr.includes("Z")
    ? DateTime.fromISO(endTimeStr).setZone(tz_peru)
    : DateTime.fromFormat(endTimeStr, "yyyy-MM-dd HH:mm:ss", { zone: tz_peru });

  const startMs = startDt.toMillis();
  const endMs = endDt.toMillis();

  const allEvents: any[] = [];
  let nextToken: string | undefined;

  // Limit to 5 pages to prevent timeouts
  let pages = 0;
  do {
    const command: FilterLogEventsCommand = new FilterLogEventsCommand({
      logGroupName,
      startTime: startMs,
      endTime: endMs,
      filterPattern,
      nextToken,
      limit: 50,
    });

    try {
      const response = await cloudWatchClient.send(command);
      if (response.events) {
        allEvents.push(...response.events.map(event => ({
          timestamp: DateTime.fromMillis(event.timestamp || 0).setZone(tz_peru).toFormat("yyyy-MM-dd HH:mm:ss"),
          message: event.message,
          stream: event.logStreamName
        })));
      }
      nextToken = response.nextToken;
      pages++;
    } catch (err: any) {
      log(`AWS Log Error: ${err.message}`);
      break;
    }
  } while (nextToken && pages < 5);

  return allEvents;
}

// --- MCP Server ---
const server = new Server(
  {
    name: "analytics-optimized",
    version: "1.3.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "scan_backorders",
        description: "OPTIMIZED: Scans database for backorders (Confirmed orders with Quantity > Committed) directly in SQL. Returns summary and IDs.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max records to return (default 50)" },
            db: { type: "string", description: "Database name (default: default)" }
          }
        }
      },
      {
        name: "get_recent_appointments",
        description: "Fetches recent appointments from the fisioterapia database.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max records to return (default 50)" },
            db: { type: "string", description: "Database name (default: fisioterapia)" }
          }
        }
      },
      {
        name: "get_aws_logs",
        description: "Fetches AWS CloudWatch logs for a specific time range.",
        inputSchema: {
          type: "object",
          properties: {
            logGroupName: { type: "string" },
            startTime: { type: "string" },
            endTime: { type: "string" },
            filterPattern: { type: "string" }
          },
          required: ["logGroupName", "startTime", "endTime"]
        }
      },
      {
        name: "analyze_orders_in_logs",
        description: "Analyzes logs for specific orders. Takes output from scan_backorders.",
        inputSchema: {
          type: "object",
          properties: {
            orders: { type: "array", items: { type: "object" } },
            logGroupNames: { type: "array", items: { type: "string" } }
          },
          required: ["orders", "logGroupNames"]
        }
      },
      {
        name: "run_query",
        description: "Executes a raw SQL SELECT query (Use scan_backorders for backorders analysis).",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            db: { type: "string" }
          },
          required: ["query"]
        }
      }
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const dbName = (request.params.arguments?.db as string) || "default";

  switch (request.params.name) {
    case "scan_backorders": {
      const limit = Number(request.params.arguments?.limit) || 50;
      try {
        const pool = await poolManager.getPool(dbName);
        // Optimized SQL Query
        const query = `
          SELECT 
            "sIdPedidoDetalle" as id,
            "sSkuProducto" as sku,
            "dtFechaPedido" as fecha,
            "nCantidad" as qty,
            "nCantidadComprometida" as committed
          FROM pedidosproduccion
          WHERE 
            "sEstadoEnvioNetsuite" = 'ENVIADO' 
            AND "sAccionDirectora" = 'CONFIRMADO' 
            AND CAST("nCantidad" AS NUMERIC) > CAST("nCantidadComprometida" AS NUMERIC)
          LIMIT $1
        `;
        
        const result = await pool.query(query, [limit]);
        return {
          content: [{ type: "text", text: JSON.stringify({
            count: result.rowCount,
            note: "Showing top results only. Use these IDs to check logs.",
            data: result.rows
          }, null, 2) }]
        };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }

    case "get_recent_appointments": {
      const limit = Number(request.params.arguments?.limit) || 50;
      const targetDb = (request.params.arguments?.db as string) || "fisioterapia";
      try {
        const pool = await poolManager.getPool(targetDb);
        const query = `SELECT * FROM appointments ORDER BY id DESC LIMIT $1`;
        const result = await pool.query(query, [limit]);
        return {
          content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }]
        };
      } catch (error: any) {
         // Fallback if 'id' or 'appointments' doesn't exist, try simple select
         try {
            const pool = await poolManager.getPool(targetDb);
            const query = `SELECT * FROM appointments LIMIT $1`;
            const result = await pool.query(query, [limit]);
            return {
              content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }]
            };
         } catch (err2: any) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
         }
      }
    }

    case "get_aws_logs": {
      const args = request.params.arguments as any;
      const logs = await fetchAWSLogs(args.logGroupName, args.startTime, args.endTime, args.filterPattern);
      return { content: [{ type: "text", text: JSON.stringify(logs, null, 2) }] };
    }

    case "analyze_orders_in_logs": {
      const { orders, logGroupNames } = request.params.arguments as any;
      const results = [];
      
      // Limit to 5 orders to prevent token explosion
      const ordersToProcess = orders.slice(0, 5); 

      for (const order of ordersToProcess) {
        const id = order.id || order.sIdPedidoDetalle;
        const date = order.fecha || order.dtFechaPedido;
        
        if (!date) continue;

        const start = DateTime.fromISO(date).minus({ minutes: 5 }).toFormat('yyyy-MM-dd HH:mm:ss');
        const end = DateTime.fromISO(date).plus({ minutes: 30 }).toFormat('yyyy-MM-dd HH:mm:ss');

        const orderLogs = [];
        for (const group of logGroupNames) {
          const logs = await fetchAWSLogs(group, start, end, `"${id}"`);
          if (logs.length > 0) {
            orderLogs.push({ group, entries: logs });
          }
        }
        results.push({ orderId: id, logs: orderLogs });
      }

      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }

    case "run_query": {
      const query = String(request.params.arguments?.query);
      if (!query.trim().toLowerCase().startsWith("select")) {
        throw new Error("Only SELECT allowed");
      }
      const pool = await poolManager.getPool(dbName);
      const res = await pool.query(query);
      return { content: [{ type: "text", text: JSON.stringify(res.rows, null, 2) }] };
    }

    default:
      throw new Error("Tool not found");
  }
});

// --- Transport Setup ---
const args = process.argv.slice(2);

if (args.includes("--stdio")) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} else {
  // --- Express & Swagger ---
  const app = express();
  app.use(cors());

  const swaggerOptions = {
    definition: {
      openapi: "3.0.0",
      info: { title: "MCP Analytics Optimized", version: "1.3.0" },
      servers: [{ url: `http://localhost:${process.env.PORT || 3032}` }],
    },
    apis: [],
  };
  const swaggerDocs = swaggerJsdoc(swaggerOptions);
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

  let transport: SSEServerTransport;

  app.get("/sse", async (req, res) => {
    transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    if (transport) await transport.handlePostMessage(req, res);
    else res.status(404).send("Transport not initialized");
  });

  // --- Chat Endpoint for n8n/External Services (Vertex AI/Gemini) ---
  app.use(express.json());

  // Reuse logic from client-chat-gemini.ts but as a REST API
  app.post("/chat", async (req, res) => {
    try {
      const { message, history } = req.body;
      const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
      const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

      if (!message) {
         res.status(400).json({ error: "Message is required" });
         return;
      }

      if (!GOOGLE_API_KEY) {
         res.status(500).json({ error: "GOOGLE_API_KEY not found in server env" });
         return;
      }

      const GEMINI_URL = `https://aiplatform.googleapis.com/v1/publishers/google/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_API_KEY}`;

      // 1. Get Tools directly from server instance (no need for MCP client loopback if local)
      // Since we are INSIDE the server, we could call tools directly, but let's use the defined tools schema
      // for consistency.
      const toolsList = [
        {
          name: "scan_backorders",
          description: "OPTIMIZED: Scans database for backorders (Confirmed orders with Quantity > Committed) directly in SQL. Returns summary and IDs.",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Max records to return (default 50)" },
              db: { type: "string", description: "Database name (default: default)" }
            }
          }
        },
        {
          name: "get_aws_logs",
          description: "Fetches AWS CloudWatch logs for a specific time range.",
          parameters: {
            type: "object",
            properties: {
              logGroupName: { type: "string" },
              startTime: { type: "string" },
              endTime: { type: "string" },
              filterPattern: { type: "string" }
            },
            required: ["logGroupName", "startTime", "endTime"]
          }
        },
        {
          name: "analyze_orders_in_logs",
          description: "Analyzes logs for specific orders. Takes output from scan_backorders.",
          parameters: {
            type: "object",
            properties: {
              orders: { type: "array", items: { type: "object" } },
              logGroupNames: { type: "array", items: { type: "string" } }
            },
            required: ["orders", "logGroupNames"]
          }
        },
        {
          name: "run_query",
          description: "Executes a raw SQL SELECT query. Use this to list tables (SELECT tablename FROM pg_tables WHERE schemaname='public') or inspect data.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              db: { type: "string" }
            },
            required: ["query"]
          }
        },
        {
            name: "inspect_schema",
            description: "Lists all tables and their columns in the database to understand structure.",
            parameters: {
              type: "object",
              properties: {
                db: { type: "string", description: "Database name to inspect (from databases.json). Optional, uses default if omitted." }
              }
            }
        }
      ];

      const geminiTools = [
        {
          function_declarations: toolsList.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters, // Note: index.ts uses inputSchema in ListTools, but here we defined it manually above for simplicity
          })),
        },
      ];

      // 3. Prepare Chat History
      // If history provided by n8n, use it. Otherwise start fresh.
      let chatHistory = history || [];
      
      const SYSTEM_PROMPT = `
Sistema: Eres un asistente de análisis de datos MCP.
Bases de Datos Disponibles (param 'db'):
- 'pedidosproduction' (Principal)
- 'fisioterapia'
- 'pedidos'

Herramientas:
- scan_backorders: Busca pedidos sin stock.
- get_recent_appointments: Obtiene citas recientes de fisioterapia.
- get_aws_logs: Logs de AWS.
- analyze_orders_in_logs: Cruza pedidos/logs.
- run_query: SQL SELECT.
- inspect_schema: Ver tablas BD.

Reglas:
1. Responde conciso.
2. Si piden tablas, usa inspect_schema.
3. Si piden backorders, usa scan_backorders.
4. Si piden citas, usa get_recent_appointments.
5. Usa SIEMPRE los nombres exactos de las BD arriba.
`;

      // Add or Update system instruction to make the AI aware of its capabilities
      if (chatHistory.length === 0) {
        // Optimization: Reduce token usage in system prompt
        chatHistory.push({
            role: "user",
            parts: [{ text: SYSTEM_PROMPT }]
        });
        chatHistory.push({
            role: "model",
            parts: [{ text: "OK" }]
        });
      } else {
        // Check if first message is system prompt and update it
        const firstMsg = chatHistory[0];
        if (firstMsg?.role === "user" && firstMsg?.parts?.[0]?.text?.includes("Sistema:")) {
             firstMsg.parts[0].text = SYSTEM_PROMPT;
        } else {
             // Prepend if missing
             chatHistory.unshift({
                role: "model",
                parts: [{ text: "OK" }]
             });
             chatHistory.unshift({
                role: "user",
                parts: [{ text: SYSTEM_PROMPT }]
             });
        }
      }

      // --- TOKEN OPTIMIZATION ---
      // Limit history to last 10 messages to save tokens and avoid limits
      if (chatHistory.length > 10) {
         // Keep the first 2 messages (System Prompt) and the last 8 messages
         const systemPrompt = chatHistory.slice(0, 2);
         const recentHistory = chatHistory.slice(-8);
         chatHistory = [...systemPrompt, ...recentHistory];
      }
      // --------------------------

      chatHistory.push({
        role: "user",
        parts: [{ text: message }]
      });

      // 3. Gemini Loop Helper
      const callGemini = async (hist: any[]) => {
        const payload = {
          contents: hist,
          tools: geminiTools,
        };
        const r = await fetch(GEMINI_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!r.ok) throw new Error(`Gemini API Error: ${r.statusText} - ${await r.text()}`);
        return await r.json();
      };

      // 4. Execution Loop
      let responseData = await callGemini(chatHistory);
      let candidate = responseData.candidates?.[0];
      let modelPart = candidate?.content?.parts?.[0];

      // Limit max turns to avoid infinite loops
      let turns = 0;
      const MAX_TURNS = 5;

      while (modelPart?.functionCall && turns < MAX_TURNS) {
         turns++;
         const fnName = modelPart.functionCall.name;
         const fnArgs = modelPart.functionCall.args;
         
         // Execute Tool Internally (Bypassing MCP Client for speed since we are on the server)
         let toolResult = "";
         try {
            // Re-use the handler logic directly
            const mockRequest = { 
                params: { 
                    name: fnName, 
                    arguments: fnArgs 
                } 
            };
            
            // We need to access the handler logic directly. 
            // Refactoring CallToolRequestSchema handler to a reusable function would be cleaner,
            // but for now let's use a quick internal dispatcher based on switch case we already have.
            
            // QUICK DISPATCHER (Copy of switch case logic)
            const dbName = (fnArgs?.db as string) || "default";
            if (fnName === "scan_backorders") {
                const limit = Number(fnArgs?.limit) || 50;
                const pool = await poolManager.getPool(dbName);
                const query = `SELECT "sIdPedidoDetalle" as id, "sSkuProducto" as sku, "dtFechaPedido" as fecha, "nCantidad" as qty, "nCantidadComprometida" as committed FROM pedidosproduccion WHERE "sEstadoEnvioNetsuite" = 'ENVIADO' AND "sAccionDirectora" = 'CONFIRMADO' AND CAST("nCantidad" AS NUMERIC) > CAST("nCantidadComprometida" AS NUMERIC) LIMIT $1`;
                const resDb = await pool.query(query, [limit]);
                toolResult = JSON.stringify({ count: resDb.rowCount, data: resDb.rows });
            }
            else if (fnName === "get_recent_appointments") {
                const limit = Number(fnArgs?.limit) || 50;
                const targetDb = (fnArgs?.db as string) || "fisioterapia";
                try {
                    const pool = await poolManager.getPool(targetDb);
                    const query = `SELECT * FROM appointments ORDER BY id DESC LIMIT $1`;
                    const resDb = await pool.query(query, [limit]);
                    toolResult = JSON.stringify(resDb.rows);
                } catch (e: any) {
                    const pool = await poolManager.getPool(targetDb);
                    const query = `SELECT * FROM appointments LIMIT $1`;
                    const resDb = await pool.query(query, [limit]);
                    toolResult = JSON.stringify(resDb.rows);
                }
            } 
            else if (fnName === "get_aws_logs") {
                 const logs = await fetchAWSLogs(fnArgs.logGroupName, fnArgs.startTime, fnArgs.endTime, fnArgs.filterPattern);
                 toolResult = JSON.stringify(logs);
            }
            else if (fnName === "analyze_orders_in_logs") {
                 // Simplified logic for internal call
                 const { orders, logGroupNames } = fnArgs;
                 const results = [];
                 const ordersToProcess = orders.slice(0, 5);
                 for (const order of ordersToProcess) {
                    const id = order.id || order.sIdPedidoDetalle;
                    const date = order.fecha || order.dtFechaPedido;
                    if (!date) continue;
                    const start = DateTime.fromISO(date).minus({ minutes: 5 }).toFormat('yyyy-MM-dd HH:mm:ss');
                    const end = DateTime.fromISO(date).plus({ minutes: 30 }).toFormat('yyyy-MM-dd HH:mm:ss');
                    const orderLogs = [];
                    for (const group of logGroupNames) {
                        const logs = await fetchAWSLogs(group, start, end, `"${id}"`);
                        if (logs.length > 0) orderLogs.push({ group, entries: logs });
                    }
                    results.push({ orderId: id, logs: orderLogs });
                 }
                 toolResult = JSON.stringify(results);
            }
            else if (fnName === "run_query") {
                 const query = String(fnArgs?.query);
                 if (!query.trim().toLowerCase().startsWith("select")) throw new Error("Only SELECT allowed");
                 const pool = await poolManager.getPool(dbName);
                 const resDb = await pool.query(query);
                 toolResult = JSON.stringify(resDb.rows);
            }
            else if (fnName === "inspect_schema") {
                const pool = await poolManager.getPool(dbName);
                const query = `
                    SELECT table_name, column_name, data_type 
                    FROM information_schema.columns 
                    WHERE table_schema = 'public' 
                    ORDER BY table_name, ordinal_position;
                `;
                const resDb = await pool.query(query);
                // Group by table for cleaner output to LLM
                const schema: Record<string, string[]> = {};
                resDb.rows.forEach(row => {
                    if (!schema[row.table_name]) schema[row.table_name] = [];
                    schema[row.table_name].push(`${row.column_name} (${row.data_type})`);
                });
                toolResult = JSON.stringify(schema);
            } else {
                 toolResult = "Tool not found or not supported in Chat API";
            }

         } catch (err: any) {
            toolResult = `Error executing tool: ${err.message}`;
         }

         // Add tool response to history
         chatHistory.push(candidate.content); // The function call request
         chatHistory.push({
            role: "function",
            parts: [{
              functionResponse: {
                name: fnName,
                response: { name: fnName, content: toolResult }
              }
            }]
         });

         // Call Gemini again
         responseData = await callGemini(chatHistory);
         candidate = responseData.candidates?.[0];
         modelPart = candidate?.content?.parts?.[0];
      }

      res.json({
        response: modelPart?.text || "(No text response)",
        history: chatHistory // Return history so n8n can maintain context if needed
      });

    } catch (error: any) {
      console.error(error);
      res.status(500).json({ error: error.message });
    }
  });

  const PORT = process.env.PORT || 3032;
  const httpServer = app.listen(PORT, () => {
    console.error(`🚀 Optimized MCP Server running on port ${PORT}`);
    console.error(`📄 Swagger: http://localhost:${PORT}/api-docs`);
  });
}

// Prevent immediate exit
setInterval(() => {}, 10000);

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

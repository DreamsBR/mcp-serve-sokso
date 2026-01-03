import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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
  console.log(msg);
}

// --- Services ---
class PoolManager {
  private pools = new Map<string, pg.Pool>();
  private configs: Record<string, string> = {};

  constructor() {
    this.loadConfigs();
  }

  loadConfigs() {
    const configPath = process.env.MCP_DB_CONFIG_PATH || "databases.json";
    if (fs.existsSync(configPath)) {
      try {
        this.configs = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } catch (error) {
        log(`Error loading database configs: ${error}`);
      }
    }

    if (process.env.DB_HOST && !this.configs["default"]) {
      const connectionString = `postgresql://${process.env.DB_USER}:${
        process.env.DB_PASSWORD
      }@${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${
        process.env.DB_NAME
      }`;
      this.configs["default"] = connectionString;
    }
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
        connectionString.includes("127.0.0.1");
      const forceSSL = !isLocal || connectionString.includes("sslmode=require");

      const pool = new pg.Pool({
        connectionString,
        ssl: forceSSL ? { rejectUnauthorized: false } : false,
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

const PORT = process.env.PORT || 3032;
const httpServer = app.listen(PORT, () => {
  console.log(`🚀 Optimized MCP Server running on port ${PORT}`);
  console.log(`📄 Swagger: http://localhost:${PORT}/api-docs`);
});

// Prevent immediate exit
setInterval(() => {}, 10000);

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

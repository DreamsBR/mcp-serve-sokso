import express, { Request, Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";
import { scanBackorders, analyzeOrdersInLogs, runQuery, inspectSchema } from "./services/tools.js";
import { fetchAWSLogs } from "./services/aws.js";
import { processQuery } from "./services/vertex.js";

// --- Configuration ---
const dotenvPath = process.env.DOTENV_PATH;
if (dotenvPath) {
  dotenv.config({ path: dotenvPath });
} else {
  dotenv.config();
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

const toolDefinitions = [
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
    description: "Executes ANY raw SQL SELECT query. Use this for flexible analysis, filtering by specific dates, grouping, etc.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The SQL SELECT query to execute" },
        db: { type: "string", description: "Database name" }
      },
      required: ["query"]
    }
  },
  {
    name: "inspect_schema",
    description: "Inspects the database schema (tables and columns).",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Optional table name. If provided, describes table. If not, lists tables." },
        db: { type: "string", description: "Database name" }
      }
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: toolDefinitions,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments as any;

  try {
    let result: any;
    switch (toolName) {
      case "scan_backorders":
        result = await scanBackorders(args.db, args.limit);
        break;
      case "get_aws_logs":
        result = await fetchAWSLogs(args.logGroupName, args.startTime, args.endTime, args.filterPattern);
        break;
      case "analyze_orders_in_logs":
        result = await analyzeOrdersInLogs(args.orders, args.logGroupNames);
        break;
      case "run_query":
        result = await runQuery(args.db, args.query);
        break;
      case "inspect_schema":
        result = await inspectSchema(args.db, args.table);
        break;
      default:
        throw new Error(`Tool ${toolName} not found`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

// --- Express & Swagger ---
const app = express();
app.use(cors());
app.use(express.json());

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

app.get("/sse", async (req: Request, res: Response) => {
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  if (transport) await transport.handlePostMessage(req, res);
  else res.status(404).send("Transport not initialized");
});

// --- New API Endpoint for Vertex AI Agent ---
app.post("/api/query", async (req: Request, res: Response) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }
    
    console.log(`[API] Processing query: ${prompt}`);
    const result = await processQuery(prompt);
    res.json({ response: result });
  } catch (error: any) {
    console.error("API Error:", error);
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
});

const PORT = process.env.PORT || 3032;
const httpServer = app.listen(PORT, () => {
  console.log(`🚀 Optimized MCP Server running on port ${PORT}`);
  console.log(`📄 Swagger: http://localhost:${PORT}/api-docs`);
  console.log(`🧠 AI Endpoint: http://localhost:${PORT}/api/query`);
});

// Prevent immediate exit
setInterval(() => {}, 10000);

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

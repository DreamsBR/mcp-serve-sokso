import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
import dotenv from "dotenv";
import fs from "fs";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { fromIni } from "@aws-sdk/credential-providers";
import { DateTime } from "luxon";
import Fastify from "fastify";
import cors from "@fastify/cors";
import OpenAI from "openai";

// --- Configuration ---
const dotenvPath = process.env.DOTENV_PATH;
if (dotenvPath) {
  dotenv.config({ path: dotenvPath });
} else {
  dotenv.config();
}

const API_KEY = process.env.API_KEY || "dev-key-123";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- Database & AWS Service ---
class AnalyticsService {
  private pools = new Map<string, pg.Pool>();
  private configs: Record<string, string> = {};
  private cloudWatchClient: CloudWatchLogsClient;

  constructor() {
    this.loadConfigs();
    this.cloudWatchClient = new CloudWatchLogsClient({
      region: process.env.AWS_REGION || "us-east-1",
      credentials: fromIni({ profile: process.env.AWS_PROFILE || "sokso" }),
    });
  }

  private loadConfigs() {
    // 1. Carga inicial desde archivo (databases.json)
    const configPath = process.env.MCP_DB_CONFIG_PATH || "databases.json";
    if (fs.existsSync(configPath)) {
      try {
        const rawConfigs = JSON.parse(fs.readFileSync(configPath, "utf8"));
        for (const [dbName, value] of Object.entries(rawConfigs)) {
          const val = value as string;
          // Si el valor en el JSON es el NOMBRE de una variable de entorno, lo resolvemos
          if (val && process.env[val]) {
            this.configs[dbName] = process.env[val]!;
          } else if (val && val.startsWith("postgresql://")) {
            this.configs[dbName] = val;
          } else {
            this.configs[dbName] = val; // Placeholder sin resolver aún
          }
        }
      } catch (error) {
        console.warn("Error al leer databases.json");
      }
    }

    // 2. Sobrescribir/Añadir desde variables de entorno directas
    for (const key in process.env) {
      if (key.startsWith("DB_") && key.endsWith("_URL")) {
        const dbName = key.replace("DB_", "").replace("_URL", "").toLowerCase();
        this.configs[dbName] = process.env[key] as string;
      }
    }

    if (Object.keys(this.configs).length === 0) {
      console.warn("⚠️ ADVERTENCIA: No se han encontrado configuraciones de base de datos.");
    }
  }

  async getPool(name = "default"): Promise<pg.Pool> {
    if (!this.pools.has(name)) {
      this.loadConfigs();
      const connectionString = this.configs[name]?.trim();
      if (!connectionString) throw new Error(`DB Config '${name}' not found.`);

      const isLocal = connectionString.includes("localhost") || connectionString.includes("127.0.0.1");
      const forceSSL = !isLocal || connectionString.includes("sslmode=require");

      const pool = new pg.Pool({
        connectionString,
        ssl: forceSSL ? { rejectUnauthorized: false } : false,
      });
      this.pools.set(name, pool);
    }
    return this.pools.get(name)!;
  }

  async runQuery(query: string, dbName = "default") {
    if (!query.trim().toLowerCase().startsWith("select")) {
      throw new Error("Solo se permiten consultas SELECT por seguridad.");
    }
    const pool = await this.getPool(dbName);
    const result = await pool.query(query);
    return result.rows;
  }

  async inspectSchema(dbName = "default") {
    const pool = await this.getPool(dbName);
    const client = await pool.connect();
    try {
      const tables = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
      const schema: Record<string, any> = {};
      for (const row of tables.rows) {
        const columns = await client.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`, [row.table_name]);
        schema[row.table_name] = columns.rows;
      }
      return schema;
    } finally {
      client.release();
    }
  }

  async fetchAWSLogs(logGroupName: string, startTime: string, endTime: string, filterPattern?: string) {
    const tz = "America/Lima";
    const startMs = DateTime.fromISO(startTime).setZone(tz).toMillis();
    const endMs = DateTime.fromISO(endTime).setZone(tz).toMillis();

    const allEvents: any[] = [];
    let nextToken: string | undefined;

    do {
      const response = await this.cloudWatchClient.send(new FilterLogEventsCommand({
        logGroupName, startTime: startMs, endTime: endMs, filterPattern, nextToken
      }));
      if (response.events) {
        allEvents.push(...response.events.map(e => ({
          timestamp: DateTime.fromMillis(e.timestamp || 0).setZone(tz).toFormat("yyyy-MM-dd HH:mm:ss"),
          message: e.message
        })));
      }
      nextToken = response.nextToken;
    } while (nextToken);
    return allEvents;
  }
}

const analytics = new AnalyticsService();

// --- OpenAI Agent ---
class OpenAIAgent {
  private openai: OpenAI | null = null;

  constructor() {
    if (OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    }
  }

  async ask(prompt: string) {
    if (!this.openai) throw new Error("OPENAI_API_KEY no configurada.");

    const tools: any[] = [
      {
        type: "function",
        function: {
          name: "run_query",
          description: "Ejecuta SQL SELECT en la base de datos de producción.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              db: { type: "string", default: "default" }
            },
            required: ["query"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "get_aws_logs",
          description: "Busca logs en AWS CloudWatch.",
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
        }
      }
    ];

    let messages: any[] = [
      { role: "system", content: "Eres un analista de datos experto. Tienes acceso a la base de datos de producción y logs de AWS. Responde siempre basándote en los datos obtenidos." },
      { role: "user", content: prompt }
    ];

    // Simple loop for tool calls (max 5)
    for (let i = 0; i < 5; i++) {
      const response = await this.openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        tools,
      });

      const message = response.choices[0].message;
      messages.push(message);

      if (!message.tool_calls) return message.content;

      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const functionName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        let result;
        if (functionName === "run_query") {
          result = await analytics.runQuery(args.query, args.db);
        } else if (functionName === "get_aws_logs") {
          result = await analytics.fetchAWSLogs(args.logGroupName, args.startTime, args.endTime, args.filterPattern);
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        });
      }
    }
    return "No pude completar el análisis tras varios intentos.";
  }
}

const agent = new OpenAIAgent();

// --- Fastify Server ---
const fastify = Fastify({ logger: true });
fastify.register(cors);

// Middleware de seguridad
fastify.addHook("preHandler", async (request, reply) => {
  const auth = request.headers.authorization;
  if (auth !== `Bearer ${API_KEY}`) {
    reply.code(401).send({ error: "No autorizado" });
  }
});

fastify.post("/ask", async (request: any) => {
  const { prompt } = request.body;
  if (!prompt) return { error: "Prompt requerido" };
  const answer = await agent.ask(prompt);
  return { answer };
});

fastify.post("/query", async (request: any) => {
  const { query, db } = request.body;
  const result = await analytics.runQuery(query, db);
  return result;
});

// --- MCP Server ---
const mcpServer = new Server({ name: "analytics-mcp", version: "2.0.0" }, { capabilities: { tools: {} } });

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "run_query",
      description: "Ejecuta SQL SELECT.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, db: { type: "string" } }, required: ["query"] }
    },
    {
      name: "get_aws_logs",
      description: "Obtiene logs de AWS.",
      inputSchema: { type: "object", properties: { logGroupName: { type: "string" }, startTime: { type: "string" }, endTime: { type: "string" }, filterPattern: { type: "string" } }, required: ["logGroupName", "startTime", "endTime"] }
    }
  ]
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments as any;
  switch (request.params.name) {
    case "run_query":
      const rows = await analytics.runQuery(args.query, args.db);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    case "get_aws_logs":
      const logs = await analytics.fetchAWSLogs(args.logGroupName, args.startTime, args.endTime, args.filterPattern);
      return { content: [{ type: "text", text: JSON.stringify(logs, null, 2) }] };
    default:
      throw new Error("Tool not found");
  }
});

// Start modes
const mode = process.env.START_MODE || "both"; // "mcp", "rest", "both"

if (mode === "mcp" || mode === "both") {
  const transport = new StdioServerTransport();
  mcpServer.connect(transport).catch(console.error);
}

if (mode === "rest" || mode === "both") {
  const port = Number(process.env.PORT) || 3000;
  fastify.listen({ port, host: "0.0.0.0" }).catch(err => {
    fastify.log.error(err);
    process.exit(1);
  });
}

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
import path from "path";
import { fileURLToPath } from 'url';
import { processQuery } from "./gemini_agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
const dotenvPath = process.env.DOTENV_PATH;
if (dotenvPath) {
  dotenv.config({ path: dotenvPath });
} else {
  dotenv.config();
}

// --- Database Service ---
class PoolManager {
  private pools = new Map<string, pg.Pool>();
  private configs: Record<string, string> = {};

  constructor() {
    this.loadConfigs();
  }

  loadConfigs() {
    const configPathEnv = process.env.MCP_DB_CONFIG_PATH;
    const possiblePaths = [
        configPathEnv,
        "databases.json",
        path.join(__dirname, 'databases.json'),
        path.join(__dirname, '..', 'databases.json')
    ].filter((p): p is string => !!p);

    let configPath = "";
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            configPath = p;
            break;
        }
    }

    if (configPath) {
      try {
        const rawConfigs = JSON.parse(fs.readFileSync(configPath, "utf8"));
        // Resolver variables de entorno en las configuraciones
        for (const [key, value] of Object.entries(rawConfigs)) {
            if (typeof value === "string" && value.startsWith("DB_") && process.env[value]) {
                this.configs[key] = process.env[value]!;
            } else {
                this.configs[key] = value as string;
            }
        }
        console.log(`Loaded database configs from ${configPath}:`, Object.keys(this.configs));
      } catch (error) {
        console.error("Error loading database configs:", error);
      }
    } else {
        console.warn(`Warning: databases.json not found. Checked: ${possiblePaths.join(", ")}`);
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
          `Configuración '${name}' no encontrada en databases.json. Disponibles: ${Object.keys(
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

// --- MCP Server Setup ---
const server = new Server(
  {
    name: "fisioterapia-analytics",
    version: "1.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// --- Tool Definitions ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Recargar configuraciones para tener la lista actualizada de bases de datos
  poolManager.loadConfigs();
  // @ts-ignore - Acceder a propiedad privada para listar DBs disponibles en la descripción
  const availableDbs = Object.keys(poolManager['configs']).join(", ");
  
  return {
    tools: [
      {
        name: "inspect_schema",
        description:
          `Lista todas las tablas y sus columnas en la base de datos para entender la estructura. Bases de datos disponibles: ${availableDbs}`,
        inputSchema: {
          type: "object",
          properties: {
            db: {
              type: "string",
              description:
                `Nombre de la base de datos a inspeccionar (según databases.json). Opcional, usa 'default' por defecto. Disponibles: ${availableDbs}`,
            },
          },
        },
      },
      {
        name: "run_query",
        description:
          `Ejecuta una consulta SQL de lectura (SELECT) en la base de datos. Bases de datos disponibles: ${availableDbs}`,
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "La consulta SQL a ejecutar. Solo se permiten SELECTs.",
            },
            db: {
              type: "string",
              description:
                `Nombre de la base de datos donde ejecutar la consulta. Opcional. Disponibles: ${availableDbs}`,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "analyze_backorders",
        description:
          "Analiza un array de pedidos para detectar Back Orders (Cantidad > Cantidad Comprometida). Requiere datos previos obtenidos con run_query.",
        inputSchema: {
          type: "object",
          properties: {
            data: {
              type: "string",
              description:
                "Datos de pedidos en formato JSON string. Debe contener: sEstadoEnvioNetsuite, sAccionDirectora, nCantidad, nCantidadComprometida.",
            },
          },
          required: ["data"],
        },
      },
    ],
  };
});

// --- Tool Implementations ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const dbName = (request.params.arguments?.db as string) || "default";

  switch (request.params.name) {
    case "inspect_schema": {
      try {
        const pool = await poolManager.getPool(dbName);
        const client = await pool.connect();
        try {
          const tablesResult = await client.query(`
                        SELECT table_name 
                        FROM information_schema.tables 
                        WHERE table_schema = 'public' 
                        AND table_type = 'BASE TABLE';
                    `);
          const schema: Record<string, any[]> = {};
          for (const row of tablesResult.rows) {
            const tableName = row.table_name;
            const columnsResult = await client.query(
              `
                            SELECT column_name, data_type, is_nullable
                            FROM information_schema.columns 
                            WHERE table_schema = 'public' 
                            AND table_name = $1;
                        `,
              [tableName]
            );
            schema[tableName] = columnsResult.rows;
          }
          return {
            content: [{ type: "text", text: JSON.stringify(schema, null, 2) }],
          };
        } finally {
          client.release();
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error inspecting schema (${dbName}): ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
    case "run_query": {
      const query = String(request.params.arguments?.query);
      if (!query.trim().toLowerCase().startsWith("select")) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Solo se permiten consultas SELECT por seguridad.",
            },
          ],
          isError: true,
        };
      }
      try {
        const pool = await poolManager.getPool(dbName);
        const client = await pool.connect();
        try {
          const result = await client.query(query);
          return {
            content: [
              { type: "text", text: JSON.stringify(result.rows, null, 2) },
            ],
          };
        } finally {
          client.release();
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error executing query (${dbName}): ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
    case "analyze_backorders": {
      const dataArg = request.params.arguments?.data;
      let rows: any[] = [];

      try {
        if (typeof dataArg === "string") {
          rows = JSON.parse(dataArg);
        } else if (Array.isArray(dataArg)) {
          rows = dataArg;
        } else {
          throw new Error(
            "El argumento 'data' debe ser un JSON string o un array."
          );
        }

        if (!Array.isArray(rows)) {
          throw new Error("Los datos proporcionados no son un array.");
        }

        // Análisis en código (Application Level)
        const backOrders = rows
          .filter((row: any) => {
            const isEnviado = row.sEstadoEnvioNetsuite === "ENVIADO";
            const isConfirmado = row.sAccionDirectora === "CONFIRMADO";
            const nCantidad = Number(row.nCantidad);
            const nComprometida = Number(row.nCantidadComprometida || 0);

            // Si nCantidadComprometida es 0 o null, y nCantidad > 0, es backorder
            // O si nCantidad > nComprometida
            return isEnviado && isConfirmado && nCantidad > nComprometida;
          })
          .map((row: any) => ({
            ...row,
            cantidad_pendiente:
              Number(row.nCantidad) - Number(row.nCantidadComprometida || 0),
          }));

        return {
          content: [
            { type: "text", text: JSON.stringify(backOrders, null, 2) },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error en analyze_backorders: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
    default:
      throw new Error("Tool not found");
  }
});

// --- Express Server (SSE) ---
const app = express();
app.use(cors());

// --- Chat Endpoint ---
app.post("/chat", express.json(), async (req, res) => {
    const prompt = req.body.prompt;
    if (!prompt) {
        res.status(400).json({ error: "Prompt is required" });
        return;
    }

    try {
        const response = await processQuery(prompt);
        res.json({ response });
    } catch (error: any) {
        console.error("Error in chat endpoint:", error);
        res.status(500).json({ error: error.message || "Internal Server Error" });
    }
});


// --- Swagger Setup ---
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "MCP Analytics Server API",
      version: "1.2.0",
      description: "API for Model Context Protocol (MCP) Server providing analytics tools.",
    },
    servers: [
      {
        url: `http://localhost:${process.env.PORT || 3032}`,
        description: "Local server",
      },
    ],
    paths: {
      "/sse": {
        get: {
          summary: "SSE Endpoint for MCP Connection",
          description: "Establishes a Server-Sent Events connection for the MCP protocol.",
          responses: {
            "200": {
              description: "Connection established",
              content: {
                "text/event-stream": {
                  schema: {
                    type: "string",
                  },
                },
              },
            },
          },
        },
      },
      "/messages": {
        post: {
          summary: "Message Endpoint for MCP",
          description: "Handles incoming JSON-RPC messages from MCP clients.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Message processed",
            },
            "404": {
              description: "Transport not initialized",
            },
          },
        },
      },
    },
  },
  apis: [], // No separate route files
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));
console.log(`Swagger UI available at http://localhost:${process.env.PORT || 3032}/api-docs`);

let transport: SSEServerTransport;

app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).send("Transport not initialized");
  }
});

const PORT = process.env.PORT || 3032; // Changed to 3032 to avoid conflicts
app.listen(PORT, () => {
  console.log(`MCP Server (SSE) running on port ${PORT}`);
});

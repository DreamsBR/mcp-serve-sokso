import { runQuery, scanBackorders, analyzeOrdersInLogs } from './tools.js';
import { fetchAWSLogs } from './aws.js';
import { poolManager } from './db.js';
import { DateTime } from 'luxon';

const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
// Use user's preferred model
const MODEL_ID = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

// Construct the URL exactly as the user confirmed works for them
const BASE_URL = `https://aiplatform.googleapis.com/v1/publishers/google/models/${MODEL_ID}:generateContent?key=${API_KEY}`;

if (!API_KEY) {
  throw new Error("GOOGLE_API_KEY or GEMINI_API_KEY is missing in environment variables.");
}

const TOOLS = [
  {
    function_declarations: [
      {
        name: "scan_backorders",
        description: "OPTIMIZED: Scans database for backorders (Confirmed orders with Quantity > Committed) directly in SQL. Returns summary and IDs.",
        parameters: {
          type: "OBJECT",
          properties: {
            limit: { type: "NUMBER", description: "Max records to return (default 50)" },
            db: { type: "STRING", description: "Database name (default: default)" }
          }
        }
      },
      {
        name: "get_aws_logs",
        description: "Fetches AWS CloudWatch logs for a specific time range.",
        parameters: {
          type: "OBJECT",
          properties: {
            logGroupName: { type: "STRING" },
            startTime: { type: "STRING" },
            endTime: { type: "STRING" },
            filterPattern: { type: "STRING" }
          },
          required: ["logGroupName", "startTime", "endTime"]
        }
      },
      {
        name: "analyze_orders_in_logs",
        description: "Analyzes logs for specific orders. Takes output from scan_backorders.",
        parameters: {
          type: "OBJECT",
          properties: {
            orders: { type: "ARRAY", items: { type: "OBJECT", properties: {} } },
            logGroupNames: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["orders", "logGroupNames"]
        }
      },
      {
        name: "run_query",
        description: "Executes ANY raw SQL SELECT query. Use this for flexible analysis, filtering by specific dates, grouping, etc.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "The SQL SELECT query to execute" },
            db: { type: "STRING", description: "Database name" }
          },
          required: ["query"]
        }
      },
      {
        name: "list_tables",
        description: "Lists all tables in the database.",
        parameters: {
          type: "OBJECT",
          properties: {
            db: { type: "STRING", description: "Database name" }
          }
        }
      },
      {
        name: "describe_table",
        description: "Get column definitions for a specific table.",
        parameters: {
          type: "OBJECT",
          properties: {
            table: { type: "STRING" },
            db: { type: "STRING" }
          },
          required: ["table"]
        }
      },
      {
        name: "inspect_schema",
        description: "Inspects the database schema (tables and columns). Equivalent to describe_table or list_tables depending on args.",
        parameters: {
          type: "OBJECT",
          properties: {
            table: { type: "STRING", description: "Optional table name. If provided, describes table. If not, lists tables." },
            db: { type: "STRING" }
          }
        }
      }
    ]
  }
];

const SYSTEM_PROMPT = `You are an expert PostgreSQL database assistant. 
  
  IMPORTANT SCHEMA INFORMATION:
    - Use 'list_tables' to see available tables.
    - Use 'describe_table' (or 'inspect_schema') to see columns for a specific table.
    - Use 'run_query' to execute ANY SQL query (filtering by date, grouping, etc.).
    - Always use double quotes for column names in PostgreSQL (e.g., "sIdPedidoDetalle").
    - Common table: 'pedidos_detalle' (contains "dtFechaPedido", "sTipoOperacionCodigo").
    - IMPORTANT: The table name is "pedidos_detalle", NOT "pedido_detalle".
    
    IMPORTANT: AVAILABLE TOOLS
    - You have access to "run_query", "scan_backorders", "get_aws_logs", "analyze_orders_in_logs", "list_tables", "describe_table", "inspect_schema".
    - You CAN and SHOULD use "run_query" to answer questions about orders, backorders, etc.
    - "scan_backorders" is a shortcut, but you can also manually query backorders using "run_query" if needed.
    - If a user asks for "last 10 confirmed orders", construct a SQL query for it.
    
    CRITICAL: DATE AND TIMESTAMP HANDLING
    - "dtFechaPedido" is a TIMESTAMP column, NOT a string.
    - The database server is in UTC (or 5 hours ahead of Peru).
    - Peru is in 'America/Lima' (UTC-5).
    - NEVER compare "dtFechaPedido" directly with a string.
    - DO NOT use CURRENT_DATE or NOW() directly as it returns server time (tomorrow if it's late in Peru).
    - ALWAYS convert the database timestamp to Peru time before comparing.
    - Correct way to query by date (Today in Peru): 
      WHERE ("dtFechaPedido" - interval '5 hours')::date = '${DateTime.now().setZone('America/Lima').toFormat('yyyy-MM-dd')}'
    
    IMPORTANT: SQL SYNTAX
    - Do NOT escape single quotes with backslashes (e.g. use 'value', NOT \'value\').
    - If mixed case column names are used, double quotes are required (e.g. "dtFechaPedido").
    - If you are unsure about column case, use describe_table first.
    
    IMPORTANT: LARGE DATASETS
    - If a query returns many rows, the system will automatically export it to a CSV file and show you a preview.
    - If you see "partial_content" in the response, inform the user that the full data is available in the generated CSV file.
    - Prefer using COUNT/GROUP BY for high-level questions instead of requesting all rows.
    
    PROCESS:
    1. Understand the user's request (e.g., specific date, grouping).
    2. Check the schema if needed.
    3. Construct a SQL query using 'run_query'.
    4. If it fails, fix the SQL and retry.
    
    CONTEXT:
    - Database 'pedidosproduction' is available. Use db='pedidosproduction' in tools when requested.
    - Today is ${DateTime.now().setZone('America/Lima').toFormat('yyyy-MM-dd')}.
    - If the user asks about "inspect_schema", use the inspect_schema tool or describe_table.
`;

export async function processQuery(prompt: string) {
  // Initialize chat history with system prompt
  const contents = [
    {
      role: "user",
      parts: [{ text: SYSTEM_PROMPT }]
    },
    {
      role: "model",
      parts: [{ text: "Understood. I am ready to help you with your PostgreSQL database queries." }]
    },
    {
      role: "user",
      parts: [{ text: prompt }]
    }
  ];

  let loopCount = 0;
  
  while (loopCount < 10) {
    loopCount++;
    
    // Call Vertex AI REST API
    const response = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: contents,
        tools: TOOLS
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Vertex AI API Error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    
    // Check for candidates
    if (!data.candidates || data.candidates.length === 0) {
      return "No response from AI model.";
    }

    const candidate = data.candidates[0];
    const content = candidate.content;
    const parts = content.parts || [];

    // Add model response to history
    contents.push(content);

    // Check for function calls
    const functionCalls = parts.filter((p: any) => p.functionCall);
    
    if (functionCalls.length === 0) {
      // No function calls, return the text
      return parts.map((p: any) => p.text).join("");
    }

    // Process function calls
    const toolResponses = [];
    
    for (const part of functionCalls) {
      const call = part.functionCall;
      const name = call.name;
      const args = call.args;
      
      console.log(`[Vertex] Calling tool: ${name}`, JSON.stringify(args));

      let toolResult: any;
      try {
        switch (name) {
          case 'scan_backorders':
              // Always use explicit DB if user didn't provide one, default to 'pedidosproduction' for this specific tool if context suggests
              const dbToUse = args.db || 'pedidosproduction';
              toolResult = await scanBackorders(dbToUse, args.limit);
              break;
          case 'run_query':
              // Clean up backslashes that might be introduced by JSON parsing of escaped quotes
              // Example: \' becomes '
              const cleanedQuery = args.query.replace(/\\'/g, "'");
              toolResult = await runQuery(args.db, cleanedQuery);
              break;
          case 'analyze_orders_in_logs':
              toolResult = await analyzeOrdersInLogs(args.orders, args.logGroupNames);
              break;
            case 'list_tables':
              const pool = await poolManager.getPool(args.db);
              const res = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
              toolResult = res.rows.map(r => r.table_name);
              break;
            case 'describe_table':
              const pool2 = await poolManager.getPool(args.db);
              const res2 = await pool2.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`, [args.table]);
              toolResult = res2.rows;
              break;
            case 'inspect_schema':
              if (args.table) {
                  const pool3 = await poolManager.getPool(args.db);
                  const res3 = await pool3.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`, [args.table]);
                  toolResult = res3.rows;
              } else {
                  const pool4 = await poolManager.getPool(args.db);
                  const res4 = await pool4.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`);
                  toolResult = res4.rows.map(r => r.table_name);
              }
              break;
            case 'get_aws_logs':
              toolResult = await fetchAWSLogs(args.logGroupName, args.startTime, args.endTime, args.filterPattern);
              break;
          default:
              throw new Error(`Tool ${name} not found`);
        }
      } catch (error: any) {
        console.error(`Error executing ${name}:`, error);
        toolResult = { error: error.message };
      }

      toolResponses.push({
        functionResponse: {
          name: name,
          response: { name: name, content: toolResult }
        }
      });
    }

    // Add tool responses to history
    contents.push({
      role: "function", // Vertex AI API expects 'function' role or specific structure for tool responses?
      // Actually Vertex AI expects role 'function' and parts with 'functionResponse'
      parts: toolResponses
    } as any);
  }

  return "Max loop count reached.";
}

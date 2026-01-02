import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({
    host: '159.89.51.78',
    port: 5432,
    user: 'postgres',
    password: 'sql123',
    database: 'fisioterapia_db',
});

function log(msg: string) {
    console.log(msg);
    fs.appendFileSync('db-test.log', msg + '\n');
}

async function testConnection() {
    try {
        fs.writeFileSync('db-test.log', 'Starting test...\n');
        log('Connecting to DigitalOcean DB...');
        const client = await pool.connect();
        log('Connected!');

        log('Fetching table list...');
        const res = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE';
    `);

        log('Tables found: ' + JSON.stringify(res.rows.map(r => r.table_name)));

        client.release();
        await pool.end();
    } catch (err: any) {
        log('Connection failed: ' + err.message);
        log(JSON.stringify(err, null, 2));
    }
}

testConnection();

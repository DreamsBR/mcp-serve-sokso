import pg from 'pg';

const pool = new pg.Pool({
    host: '159.89.51.78',
    port: 5432,
    user: 'postgres',
    password: 'sql123',
    database: 'fisioterapia_db'
});

async function analyze() {
    try {
        console.log('--- 📊 ANÁLISIS DE BASE DE DATOS FISIOTERAPIA ---');
        const client = await pool.connect();

        // 1. Resumen de Tablas
        const tables = await client.query(`
      SELECT table_name, 
             (SELECT count(*) FROM information_schema.columns WHERE table_name = t.table_name) as cols
      FROM information_schema.tables t
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
        console.log('\n📁 Tablas Detectadas:', tables.rows.map(t => `${t.table_name}`).join(', '));

        // 2. Conteo de Citas por Estado
        console.log('\n📅 Citas por Estado:');
        try {
            const citasStatus = await client.query(`
        SELECT status, COUNT(*) as total 
        FROM appointments 
        GROUP BY status
      `);
            if (citasStatus.rows.length === 0) console.log('   (No hay citas registradas)');
            citasStatus.rows.forEach(r => console.log(`   - ${r.status}: ${r.total}`));
        } catch (e) { console.log('   Error leyendo appointments (¿Tabla vacía o no existe?)'); }

        // 3. Especialistas
        console.log('\nd Especialistas:');
        try {
            const docs = await client.query(`SELECT "firstName", "lastName" FROM specialists`);
            if (docs.rows.length === 0) console.log('   (No hay especialistas)');
            docs.rows.forEach(r => console.log(`   - Dr/a. ${r.firstName} ${r.lastName}`));
        } catch (e) { console.log('   Error leyendo specialists'); }

        // 4. Admins
        const admins = await client.query('SELECT count(*) FROM admins');
        console.log(`\n🔐 Administradores registrados: ${admins.rows[0].count}`);

        client.release();
        await pool.end();

    } catch (err: any) {
        console.error('❌ Error de conexión:', err.message);
    }
}

analyze();

# Guía de Despliegue en DigitalOcean Droplet

Sigue estos pasos para poner tu servidor MCP en producción.

## Requisitos Previos en el Droplet
Asegúrate de tener **Docker** y **Docker Compose** instalados en tu Droplet.
```bash
# Ubuntu
sudo apt update
sudo apt install docker.io docker-compose-v2 -y
```

## Pasos para Desplegar

### 1. Subir el código
Puedes clonar tu repositorio git (recomendado) o subir los archivos manualmente via SCP/SFTP.

Archivos necesarios:
- `Dockerfile`
- `docker-compose.yml`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `databases.json`
- carpeta `src/`

### 2. Configurar Variables de Entorno
Crea un archivo `.env` en el servidor (en la misma carpeta que `docker-compose.yml`):

```bash
nano .env
```

Pega el contenido de tu `.env` local (asegúrate de incluir las credenciales de base de datos y claves de API).

### 3. Iniciar el Servicio
Ejecuta el siguiente comando para construir e iniciar el contenedor en segundo plano:

```bash
docker compose up -d --build
```

### 4. Verificar
Revisa que esté corriendo:
```bash
docker ps
docker logs analytics-mcp
```

### 5. Abrir Puertos (Firewall)
Si usas UFW (firewall de Ubuntu), permite el tráfico en el puerto 3032:
```bash
sudo ufw allow 3032/tcp
```

## Conexión desde otros servicios
Tu MCP estará disponible en:
`http://TU_IP_DROPLET:3032/sse`

Endpoint Swagger (Documentación):
`http://TU_IP_DROPLET:3032/api-docs`

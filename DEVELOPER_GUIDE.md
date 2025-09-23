# Guía para Desarrolladores - Perplexity Proxy Backend

## 1. Visión General

Este proyecto es un backend ligero basado en Express.js, diseñado para ser desplegado como un conjunto de funciones serverless en Vercel. Actúa como un intermediario seguro (un proxy) entre la aplicación estática de la Biblioteca y varias APIs de terceros, gestionando claves de API y lógica de negocio que no debe exponerse en el lado del cliente.

## 2. Endpoints de la API

El backend expone tres endpoints principales dentro del directorio `/api`.

### 2.1. `POST /api/proxy`

Este es el endpoint principal con doble funcionalidad:

-   **Proxy para Gemini API:**
    -   **Acción:** Reenvía una solicitud de `prompt` a la API de Gemini (`gemini-1.5-flash-latest`).
    -   **Cuerpo de la Solicitud (JSON):** `{ "prompt": "Tu texto aquí" }`
    -   **Lógica:** Inyecta de forma segura la `GEMINI_API_KEY` del lado del servidor antes de enviar la solicitud a Google. Devuelve la respuesta de Gemini al cliente.

-   **Validación de Contraseña de Administrador:**
    -   **Acción:** Verifica la contraseña para el modo administrador de la Biblioteca.
    -   **Cuerpo de la Solicitud (JSON):** `{ "action": "validate_password", "password": "la_clave_del_usuario" }`
    -   **Lógica:** Compara la `password` recibida con la variable de entorno `BIBLIOTECA_ADMIN`.

### 2.2. `POST /api/upload`

-   **Acción:** Gestiona la subida de archivos de libros.
-   **Cuerpo de la Solicitud:** `multipart/form-data` con un campo de archivo llamado `ebook`.
-   **Lógica:**
    1.  Recibe el archivo.
    2.  Lo sube a una carpeta específica en Google Drive usando las credenciales de la API de Google.
    3.  Establece los permisos del archivo en Google Drive para que sea públicamente legible.
    4.  Devuelve un JSON con las URLs de visualización (`viewUrl`) y descarga (`downloadUrl`) del archivo.

### 2.3. `POST /api/extract-cover`

-   **Acción:** Extrae la portada de un archivo de libro (actualmente solo EPUB) y la guarda.
-   **Cuerpo de la Solicitud:** `multipart/form-data` con un campo de archivo y un campo de texto `bookId`.
-   **Lógica:**
    1.  Extrae la imagen de portada del archivo EPUB.
    2.  Sube esa imagen a Google Drive.
    3.  Actualiza la fila correspondiente en la tabla `books` de Supabase, añadiendo la URL de la nueva portada en el campo `url_portada`.

## 3. Configuración y Puesta en Marcha

### 3.1. Variables de Entorno

Para que el backend funcione, es necesario configurar las siguientes variables de entorno en un fichero `.env` (para desarrollo local) o en la configuración del proyecto en Vercel.

```
# Clave de la API de Gemini de Google
GEMINI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx

# Contraseña para el modo administrador de la Biblioteca
BIBLIOTECA_ADMIN=tu_contraseña_secreta

# Credenciales de Supabase
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_SERVICE_KEY=tu_clave_de_servicio_de_supabase

# Credenciales de la API de Google para Google Drive
# (Obtenidas desde Google Cloud Console para una cuenta de servicio o cliente OAuth2)
GOOGLE_CLIENT_ID=xxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxxxxxxxxx
GOOGLE_REDIRECT_URI=https://developers.google.com/oauthplayground
GOOGLE_REFRESH_TOKEN=1//xxxxxxxxxxxx

# ID de la carpeta de Google Drive donde se subirán los archivos
GOOGLE_DRIVE_FOLDER_ID=xxxxxxxxxxxx
```

### 3.2. Ejecución en Desarrollo Local

1.  **Instalar Dependencias:**
    ```bash
    npm install
    ```

2.  **Crear Fichero de Entorno:**
    -   Crea un fichero llamado `.env` en la raíz del proyecto.
    -   Añade todas las variables de entorno listadas en la sección 3.1.

3.  **Iniciar el Servidor:**
    -   El script principal es `api/proxy.js`. Puedes iniciarlo con Node.js para probarlo.
    ```bash
    node api/proxy.js
    ```
    -   El servidor se iniciará (por defecto en el puerto 3000) y mostrará en la consola si las variables de entorno están cargadas.

### 3.3. Despliegue en Vercel

1.  **Conectar Repositorio:** Conecta tu repositorio de GitHub a tu cuenta de Vercel.
2.  **Configurar Proyecto:**
    -   Vercel detectará automáticamente que es un proyecto Node.js.
    -   El `vercel.json` incluido se encargará de configurar las reescrituras de las rutas (`/api/proxy` -> `/api/proxy.js`).
3.  **Añadir Variables de Entorno:**
    -   En la configuración del proyecto en Vercel, ve a `Settings -> Environment Variables`.
    -   Añade todas las variables de entorno listadas en la sección 3.1.
4.  **Desplegar:**
    -   Cada `push` a la rama principal (o la configurada) activará un nuevo despliegue.

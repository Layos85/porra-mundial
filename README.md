# ⚽🏆 Porra del Mundial — online entre amigos

Web para hacer una **porra del Mundial entre amigos** desde dieciseisavos, con
**dinero ficticio** y **cuotas tipo casa de apuestas**. Es **multijugador online**:
cada amigo entra desde su móvil con un código y todo se **sincroniza en tiempo real**.

Stack: web estática (HTML/JS) en **GitHub Pages** + base de datos **Supabase** (gratis).
Es un proyecto independiente; no comparte nada con otros proyectos.

## Qué se puede hacer

- **Crear una porra** (genera un código) e **invitar amigos** con ese código.
- **Inventar apuestas** de varios tipos: 🥅 Resultado (1X2), 🔢 Marcador exacto,
  ⚽ Goleador, 🔀 Sí/No y ✨ Especial. Cada opción lleva **su cuota**.
- **Apostar dinero ficticio** a las apuestas de los demás. Premio = *apostado × cuota*.
- **Resolver** una apuesta marcando la ganadora → se pagan los premios automáticamente.
- **Clasificación** en tiempo real por monedas.

---

## Puesta en marcha (una sola vez)

### 1) Base de datos en Supabase
1. Crea una cuenta y un proyecto gratis en <https://supabase.com>.
2. Abre **SQL Editor → New query**, pega todo el contenido de
   [`supabase-schema.sql`](supabase-schema.sql) y pulsa **Run**.
3. Ve a **Project Settings → API** y copia:
   - **Project URL** (ej. `https://xxxx.supabase.co`)
   - **anon public** key (clave larga; es segura para la web).

### 2) Poner las claves en la web
Edita [`config.js`](config.js) y rellena:
```js
window.PORRA_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJI..."
};
```
> Alternativa rápida para probar: abre la web sin configurar y pega las claves en
> la pantalla de configuración (se guardan solo en tu navegador). Para que **todos**
> compartan datos, lo recomendable es ponerlas en `config.js`.

### 3) Publicar en GitHub Pages
1. En GitHub: **Settings → Pages**.
2. **Source: Deploy from a branch**, rama `main`, carpeta `/ (root)` → **Save**.
3. En 1–2 minutos tendrás una URL pública (`https://<usuario>.github.io/seguimiento-habitos/`).
   Compártela con tus amigos junto con el **código de la porra**.

---

## Cómo se juega
1. Cada amigo abre la URL.
2. Uno **crea la porra** (pone nombre, su nombre y saldo inicial) y comparte el **código**.
3. Los demás pulsan **Unirse a una porra**, meten el código y eligen su nombre.
4. Cualquiera puede **crear apuestas** y **apostar** a las de los demás.
5. Quien quiera **resuelve** la apuesta cuando se sepa el resultado y se pagan los premios.

## Probar sin instalar nada (demo)
Abre [`demo.html`](demo.html) directamente en el navegador (móvil u ordenador):
es una **demo offline** con datos de ejemplo y una base de datos simulada en tu
navegador. Puedes pronosticar marcadores, apostar, crear apuestas y resolver
partidos para ver cómo funciona. El botón «🔄 Reiniciar demo» lo deja de cero.
No necesita Supabase ni conexión.

## Archivos
- `index.html` — interfaz.
- `demo.html` — versión de demostración offline (autocontenida).
- `app.js` — lógica y conexión con Supabase (tiempo real).
- `config.js` — tus claves de Supabase.
- `supabase-schema.sql` — script de la base de datos.

# Porra del Mundial 2026 — Rediseño del sistema de apuestas

**Fecha:** 2026-06-24
**Estado:** Diseño aprobado (pendiente de revisión final del spec)
**Repo:** Layos85/seguimiento-habitos · rama `claude/mundial-betting-pool-5a0v1d`

---

## 1. Resumen

Rediseño del juego: pasa de "porras por código con dinero ficticio y apuestas creadas a mano"
a una **liga global única** donde **todos los partidos del Mundial 2026 aparecen y se
actualizan solos**. El **partido** es la entidad central. Cada usuario **pronostica el
marcador de cada partido** (gana puntos por acertar) y puede **retar a otros usuarios 1
contra 1** sobre mercados del partido, robándose puntos entre ellos.

**Una sola moneda: puntos** (la "hucha" de cada usuario). Hucha inicial = **1000 puntos**.

---

## 2. Objetivos (criterios verificables)

1. Los partidos del Mundial 2026 se cargan automáticamente desde una API, sin meterlos a mano.
2. Los resultados y el avance del cuadro eliminatorio se actualizan solos, aunque nadie tenga
   la web abierta.
3. Cada usuario puede poner un marcador a cada partido y recibe puntos automáticamente al
   finalizar según acierte marcador exacto o solo ganador.
4. Un usuario puede crear un reto 1v1 sobre un mercado de un partido; otro lo acepta; al
   finalizar, el perdedor transfiere puntos al ganador (suma cero).
5. Hay una única clasificación global por puntos.

---

## 3. Arquitectura

- **Frontend:** web estática (HTML/JS) en GitHub Pages. Se mantiene el stack actual.
- **Backend de datos:** Supabase (Postgres + Realtime). Se mantiene.
- **Sincronización automática (nuevo):** función programada con **pg_cron** en Supabase
  (cada ~5 min) que llama a la API de fútbol y vuelca/actualiza partidos, resultados y
  emparejamientos en la tabla `matches`. Como la actualización ocurre en la propia BD, la web
  la ve por Realtime sin intervención de nadie.
- **Fuente de datos:** **openfootball/worldcup.json** (JSON público, sin API key, calendario
  completo 2026 incluyendo eliminatorias que se rellenan). Plan B: football-data.org (plan
  gratis, 10 req/min).
- **Cuadro eliminatorio:** NO se calcula en la app; se **espeja** lo que diga la API según
  salen los resultados. Los partidos de eliminatoria existen desde el principio con equipos
  "por determinar" (ej. "1º Grupo A") y se vuelven jugables cuando la API fija los equipos.

> **Riesgo (frescura de datos):** openfootball se actualiza por *commits* de la comunidad, así
> que un resultado puede tardar minutos/horas en aparecer (no es live-score al segundo). Es
> aceptable para un juego entre amigos (los puntos se liquidan igual, solo más tarde). Si se
> quiere mayor inmediatez, el plan B (football-data.org) da resultados más rápidos a cambio de
> gestionar una API key y su límite de 10 req/min. La elección final de fuente se valida en el
> plan de implementación.

### Mecanismo del cron
- `pg_cron` programa una llamada periódica a una función SQL/Edge.
- La función usa `pg_net` (HTTP desde Postgres) para descargar el JSON de openfootball.
- Hace *upsert* en `matches` por `ext_id`: actualiza `status`, `score_a`, `score_b`,
  `team_a`, `team_b`, `kickoff`.
- Tras el upsert, **liquida** lo que haya quedado finalizado y sin liquidar:
  reparte puntos de `predictions` y resuelve `challenges` aceptados.
- Idempotente: liquidar dos veces el mismo partido no duplica puntos (flag `settled`).

---

## 4. Modelo de datos (Supabase)

> Sustituye el modelo actual (`pools`, `bets`, `wagers` por código). Se rehace el esquema.

### `players` (global, sin pools)
| campo | tipo | nota |
|---|---|---|
| id | uuid PK | |
| name | text | nombre visible |
| recovery_code | text unique | código corto para recuperar identidad en otro dispositivo |
| points | numeric | la hucha; default 1000 |
| created_at | timestamptz | |

### `matches` (lo llena el cron)
| campo | tipo | nota |
|---|---|---|
| id | uuid PK | |
| ext_id | text unique | id del partido en la API |
| stage | text | grupos / dieciseisavos / octavos / cuartos / semis / final |
| grp | text | grupo (A..L) si aplica |
| team_a | text | equipo o placeholder ("1º Grupo A") |
| team_b | text | |
| teams_known | boolean | true cuando ambos equipos son selecciones reales |
| kickoff | timestamptz | |
| status | text | scheduled / live / finished |
| score_a | integer | null hasta que haya resultado |
| score_b | integer | |
| settled | boolean | true cuando ya se repartieron puntos |

### `predictions` (porra base — marcador)
| campo | tipo | nota |
|---|---|---|
| id | uuid PK | |
| match_id | uuid FK | |
| player_id | uuid FK | |
| pred_a | integer | marcador previsto local |
| pred_b | integer | marcador previsto visitante |
| created_at / updated_at | timestamptz | editable hasta el kickoff |

Restricción única `(match_id, player_id)` — un pronóstico por jugador y partido.

### `challenges` (retos 1v1 — apuestas por fuera)
| campo | tipo | nota |
|---|---|---|
| id | uuid PK | |
| match_id | uuid FK | |
| market | text | `1x2` / `ou25` (más/menos 2.5) / `btts` (ambos marcan) |
| selection | text | lado que defiende el creador (ej. `1`, `X`, `2`; `over`/`under`; `si`/`no`) |
| odds | numeric | cuota decimal acordada por el creador (sugerida por tabla de fuerza) |
| stake | numeric | puntos que arriesga el creador |
| creator_id | uuid FK | |
| taker_id | uuid FK | null hasta que alguien acepta |
| status | text | open / accepted / resolved / void |
| result_won_by | uuid | ganador tras liquidar |
| created_at / resolved_at | timestamptz | |

---

## 5. Flujo — Porra base (puntos por acertar)

1. El usuario ve la lista de partidos (próximos / en juego / finalizados).
2. En un partido futuro pone su marcador (ej. `2-1`). **Poner el marcador es la acción base
   obligatoria para "entrar" a un partido.** Editable hasta el pitido inicial; al empezar
   (`status=live`) se bloquea.
3. Al finalizar (`status=finished`), el cron reparte puntos = **base × factor de dificultad**:
   - **Marcador exacto → base +50** *(configurable)*
   - **Solo el ganador / empate acertado → base +20** *(configurable)*
   - **Fallo → 0**
4. Los puntos (ya multiplicados) entran en la hucha del jugador.

### 5.1 Factor de dificultad (más puntos si hay sorpresa)

El premio sube cuando el acierto era improbable. La "probabilidad" se estima con la **tabla de
fuerza de selecciones** (ver §6, compartida con los retos): de la diferencia de fuerza entre
los dos equipos se calcula, con un modelo logístico tipo Elo, la probabilidad de cada
resultado (local / empate / visitante). El factor depende de la probabilidad del **resultado
que realmente ocurrió**:

| Probabilidad del resultado real | Etiqueta | Factor | Ej. ganador (base 20) | Ej. exacto (base 50) |
|---|---|---|---|---|
| ≥ 50 % | Favorito claro | ×1 | +20 | +50 |
| 30 – 50 % | Igualado | ×1.5 | +30 | +75 |
| < 30 % | **Sorpresa** | ×3 | +60 | +150 |

- El factor se aplica **igual a marcador exacto y a solo-ganador** (el exacto ya paga más por
  su base mayor).
- **Se conoce de antemano:** cada partido muestra su etiqueta (Favorito / Igualado / Sorpresa)
  y los puntos que pagaría, calculados antes del partido y congelados al iniciarse.
- Umbrales y factores (50 %, 30 %, ×1.5, ×3) son **configurables** en un solo sitio.

---

## 6. Flujo — Retos 1 contra 1 (robar puntos)

Modelo *exchange* (mercado de apuestas entre amigos), matemática de cuota real:

1. Sobre un partido (con equipos conocidos y aún no empezado), el usuario **crea un reto**:
   elige `market`, `selection`, `odds` (pre-rellenada con una cuota sugerida desde una tabla
   de fuerza de selecciones que incluimos; el creador puede ajustarla) y `stake` (puntos que
   arriesga). Solo puede arriesgar puntos que tiene.
2. Otro usuario **acepta el otro lado**. Su responsabilidad (puntos en riesgo) =
   `stake × (odds − 1)`. Ejemplo: creador apuesta 100 a cuota 1.5 → quien acepta arriesga 50
   para ganar los 100 del creador. Al aceptar, se reservan los puntos de ambos.
3. Al finalizar el partido, el cron resuelve según `market`/`selection` y el resultado real:
   - **el perdedor transfiere sus puntos reservados al ganador** (suma cero, robo literal).
4. Retos en estado `open` (sin aceptar) al llegar el kickoff → `void`: se devuelven los
   puntos reservados al creador.

**Mercados soportados:** `1x2`, `ou25` (más/menos 2.5 goles), `btts` (ambos marcan).
(No se incluye marcador exacto como reto en V1.)

> **Nota sobre las cuotas:** las APIs gratuitas no traen cuotas de casa de apuestas. En el
> modelo 1v1 la cuota la fija quien crea el reto, con una **sugerencia** calculada de una
> **tabla estática de fuerza de selecciones** (estilo ranking FIFA/Elo) que se incluye en el
> repo. Esa **misma tabla** alimenta el factor de dificultad de la porra base (§5.1). Cuota
> exacta de una casa real requeriría una API de pago; queda fuera de alcance.

---

## 7. Clasificación

**Una sola hucha = una sola clasificación global** ordenada por `points`.
- La porra base es el "sueldo" (sumas puntos acertando).
- Los retos 1v1 son el "casino" (puntos se mueven entre jugadores).
- No se puede quedar en negativo: solo se arriesga lo que se tiene; las reservas de retos
  bloquean puntos disponibles.
- Si un jugador se queda sin puntos, sigue pudiendo sumar con la porra base.

---

## 8. Identidad (sin códigos de grupo)

- El usuario entra, escribe su nombre → se crea un `player` global; el dispositivo lo recuerda
  (localStorage, con el mismo *fallback* a memoria que ya existe).
- Se genera un `recovery_code` corto para recuperar la identidad en otro dispositivo.
- Sin contraseñas (juego casual). RLS abierta como hoy (políticas `for all using (true)`),
  dado que son puntos ficticios sin datos personales sensibles.

---

## 9. Seguridad de saldo (integridad de puntos)

Toda mutación de puntos va por **funciones atómicas** en Postgres (`security definer`),
nunca por updates sueltos desde el cliente, para evitar carreras y trampas:
- `place_prediction(match, player, a, b)` — valida que el partido no ha empezado.
- `create_challenge(...)` / `accept_challenge(...)` — validan saldo y reservan puntos.
- `settle_match(match)` — idempotente; reparte porra + resuelve retos; marca `settled`.

---

## 10. Fuera de alcance (V1)

- Cuotas reales de casa de apuestas en vivo (necesita API de pago).
- Marcador exacto como mercado de reto 1v1.
- Cuentas con contraseña / login real.
- Múltiples torneos (solo Mundial 2026).

---

## 11. Parámetros configurables (en un solo sitio del código)

| parámetro | valor por defecto |
|---|---|
| Hucha inicial | 1000 |
| Puntos base marcador exacto | +50 |
| Puntos base solo ganador | +20 |
| Umbrales de dificultad | ≥50 % ×1 · 30–50 % ×1.5 · <30 % ×3 |
| Mercados de reto | 1x2, ou25, btts |
| Frecuencia del cron | 5 min |
| Fuente de datos | openfootball/worldcup.json |
| Tabla de fuerza de selecciones | estática en el repo (ranking FIFA/Elo) |

# Porra del Mundial 2026 — Rediseño del sistema de apuestas

**Fecha:** 2026-06-24 (rev. 2 — modelo final tras validar con demo interactiva)
**Estado:** Diseño aprobado vía demo (pendiente de regenerar el plan de implementación)
**Repo:** Layos85/seguimiento-habitos · rama `claude/mundial-betting-pool-5a0v1d`
**Demo de referencia:** artifact `porra-mundial-demo` (offline, refleja este modelo)

---

## 1. Resumen

Liga global única donde **todos los partidos del Mundial 2026 aparecen y se actualizan
solos**. El **partido** es la entidad central. Dos capas de juego, **una sola moneda: puntos**
(la "hucha", inicial **1000**):

1. **Porra base** — cada usuario pronostica el marcador de cada partido. Gana puntos por
   acertar; **más cuanto mayor es la sorpresa**.
2. **Retos** — un usuario crea una apuesta sobre un partido (con cuota de casa) que **pueden
   aceptar varios rivales** (cupo configurable); el creador gana/pierde puntos contra cada
   rival por separado.

---

## 2. Objetivos (criterios verificables)

1. Los partidos del Mundial 2026 se cargan automáticamente desde una API, sin meterlos a mano.
2. Resultados y emparejamientos del cuadro se actualizan solos (cron), aunque nadie tenga la
   web abierta.
3. Cada usuario pone un marcador a cada partido y recibe puntos automáticamente al finalizar,
   con multiplicador por dificultad (sorpresa).
4. Un usuario crea un reto sobre un mercado de un partido, **define cuántos pueden aceptarlo**,
   y varios rivales lo aceptan; al finalizar, los puntos se mueven entre creador y cada rival
   (suma cero por par).
5. Las cuotas de los retos están **alineadas con las casas de apuestas** donde existen (vía API
   de odds), con modelo propio de respaldo.
6. Una única clasificación global por puntos.

---

## 3. Arquitectura

- **Frontend:** web estática (HTML/JS) en GitHub Pages.
- **Datos:** Supabase (Postgres + Realtime).
- **Sincronización (cron):** Edge Function (Deno/TS) programada con pg_cron, cada ~5 min:
  vuelca partidos/resultados, liquida lo finalizado. La web lo ve por Realtime.
- **Fuentes de datos externas:**
  - **Calendario + resultados + goleadores:** `openfootball/worldcup.json` (JSON público, sin
    key). Estructura verificada: `matches[]` con `round/date/time/team1/team2/score.ft/group/
    ground/num` y `goals1[]/goals2[]` (goleador + minuto). 104 partidos.
  - **Convocatorias (para el mercado Goleador):** `openfootball/worldcup.squads.json` (48
    selecciones × 26 jugadores).
  - **Cuotas reales:** **The Odds API** (plan gratis 500 créditos/mes). Cubre mercados
    estándar de fútbol (1X2, más/menos, ambos marcan). Se consultan **1-2 veces al día** para
    los próximos partidos y se **cachean**; como la cuota de un reto se congela al crearlo, no
    hace falta tiempo real. Cobertura del Mundial 2026 a verificar en implementación; si falla,
    se usa el modelo propio (abajo) como fallback.

### Cuotas: híbrido real + modelo
| Mercado | Cuota |
|---|---|
| Resultado (1X2), Más/Menos (1.5/2.5/3.5), Ambos marcan | **Real** (The Odds API), modelo de respaldo |
| Par/Impar, Marcador exacto, Goleador | **Modelo propio** (las casas no las dan en plan gratis) |

**Modelo propio de cuotas (respaldo/mercados sin odds reales):** probabilidad 1X2 por fuerza
Elo + modelo de goles Poisson (λ por equipo según fuerza) para más/menos, ambos marcan, exacto
y goleador, con **margen de casa ~6%**. (Validado en la demo.)

### id estable de partido
- Eliminatorias traen `num` → `n{num}` (estable aunque el equipo sea aún "W74"/"2A").
- Grupos no traen `num` → `{date}__{ground}`.

---

## 4. Modelo de datos (Supabase)

### `config` (fila única)
`start_points=1000`, `pts_exact=50`, `pts_winner=20`, umbrales/factores de dificultad
(`thr_fav=0.50`, `thr_even=0.30`, `fac_even=1.5`, `fac_surprise=3`), `odds_margin=0.94`.

### `team_strength` (48) — rating Elo por selección (modelo de cuotas + dificultad).
### `team_squads` — `team`, `player`, `pos` (de squads.json; alimenta el desplegable Goleador).

### `players` — `id`, `name`, `recovery_code`, `points` (default 1000), `created_at`.

### `matches` — `id`, `ext_id` (unique), `stage`, `grp`, `team_a`, `team_b`, `teams_known`,
`kickoff`, `status` (scheduled/live/finished), `score_a`, `score_b`, `scorers` (jsonb, nombres
de goleadores), `p_a`, `p_draw`, `p_b` (probabilidades congeladas al conocerse los equipos),
`odds` (jsonb cacheado de The Odds API por mercado), `settled`.

### `predictions` (porra base) — `match_id`, `player_id`, `pred_a`, `pred_b`, `points`.
Único `(match_id, player_id)`. Editable hasta el kickoff.

### `challenges` (retos 1-contra-varios)
`id`, `match_id`, `creator_id`, `market` (`1x2`/`ou`/`btts`/`oddeven`/`exact`/`scorer`),
`line` (para `ou`: 1.5/2.5/3.5), `selection` (lado/score/jugador), `odds` (congelada al crear),
`stake`, `max_takers` (0 = sin límite), `status` (open/resolved/void), `created_at`,
`resolved_at`, `creator_won`.

### `challenge_takers` (cada rival que acepta un reto)
`id`, `challenge_id`, `player_id`, `liability` (= `stake × (odds−1)`, reservada al aceptar),
`created_at`. Único `(challenge_id, player_id)`.

---

## 5. Porra base (puntos por acertar)

1. El usuario pone su marcador a cada partido futuro (acción base obligatoria para "entrar").
   Editable hasta el kickoff; al empezar se bloquea.
2. Al finalizar, el cron reparte **puntos = base × factor de dificultad**:
   - Marcador exacto → base **+50**; solo ganador/empate → base **+20**; fallo → 0.

### 5.1 Factor de dificultad (sorpresa)
De la fuerza de los dos equipos (Elo) se estima la probabilidad de cada resultado. El factor
depende de la probabilidad del **resultado real**:

| Prob. del resultado real | Etiqueta | Factor | Ej. ganador (20) | Ej. exacto (50) |
|---|---|---|---|---|
| ≥ 50 % | Favorito | ×1 | +20 | +50 |
| 30–50 % | Igualado | ×1.5 | +30 | +75 |
| < 30 % | **Sorpresa** | ×3 | +60 | +150 |

Se calcula y se muestra **antes** del partido (cada partido enseña su etiqueta) y se congela al
empezar. Umbrales/factores configurables.

---

## 6. Retos (1 contra varios)

### Mercados (6)
| Mercado | Selección | Resolución (marcador final / goleadores) |
|---|---|---|
| `1x2` Resultado | 1 / X / 2 | signo de a−b |
| `ou` Más/Menos | over/under, línea 1.5/2.5/3.5 | a+b vs línea |
| `btts` Ambos marcan | sí / no | a>0 y b>0 |
| `oddeven` Par/Impar | par / impar | (a+b) % 2 |
| `exact` Marcador exacto | un marcador (ej. 2-1) | a==x y b==y |
| `scorer` Goleador | un jugador de la convocatoria | el jugador está en `scorers` |

### Flujo
1. Sobre un partido con equipos conocidos y no empezado, el creador elige mercado, selección,
   **cuota** (pre-rellenada: real de casa si existe, si no del modelo), `stake` y
   **`max_takers`** (1/2/3/5/∞). Se reserva `stake` del creador.
2. Varios rivales aceptan (hasta `max_takers`). Cada aceptación reserva la
   **responsabilidad del rival = `stake × (odds−1)`**, y reserva **otro `stake` del creador**
   (su exposición crece por cada rival; si no le queda saldo, no admite más). Un usuario no
   puede aceptar su propio reto ni dos veces.
3. Al finalizar, por **cada par creador↔rival** (suma cero):
   - Creador acierta → creador gana la responsabilidad del rival; rival la pierde.
   - Creador falla → rival gana el `stake`; creador lo pierde.
4. Reto sin rivales al kickoff → `void`, se devuelve el `stake` al creador.

> La cuota se **congela al crear** el reto (`challenges.odds`), así que las cuotas externas solo
> se necesitan en ese momento (cacheadas), no en vivo.

---

## 7. Clasificación
Una sola hucha = una sola clasificación global por `points`. La porra base es el "sueldo"; los
retos mueven puntos entre jugadores. No se puede quedar en negativo (solo se arriesga lo que se
tiene; las reservas bloquean saldo disponible).

## 8. Identidad (sin códigos de grupo)
Entras con tu nombre → `player` global; el dispositivo te recuerda (localStorage). Código de
recuperación para otro dispositivo. Sin contraseñas (casual). RLS abierta (puntos ficticios,
sin datos personales).

## 9. Integridad de puntos
Toda mutación de puntos va por funciones atómicas Postgres (`security definer`):
`upsert_player`, `place_prediction`, `create_challenge`, `accept_challenge`, `settle_match`
(idempotente), `void_started_open_challenges`.

## 10. Fuera de alcance (V1)
- Cuotas reales en vivo al segundo (se cachean 1-2×/día; suficiente porque se congelan al crear).
- Cuotas reales para par/impar, exacto y goleador (no las dan gratis → modelo).
- Cuentas con contraseña / login real.
- Otros torneos (solo Mundial 2026).

## 11. Parámetros configurables (un solo sitio)
| parámetro | valor |
|---|---|
| Hucha inicial | 1000 |
| Puntos base exacto / ganador | +50 / +20 |
| Umbrales dificultad | ≥50% ×1 · 30–50% ×1.5 · <30% ×3 |
| Mercados de reto | 1x2, ou(1.5/2.5/3.5), btts, oddeven, exact, scorer |
| Cupo de rivales por reto | 1/2/3/5/∞ (default 3) |
| Margen de cuota (modelo) | 6 % |
| Frecuencia cron resultados | 5 min |
| Frecuencia fetch cuotas | 1-2×/día (cache) |
| Fuentes | openfootball worldcup.json + squads.json + The Odds API |

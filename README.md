# ⚽🏆 Porra del Mundial

Web sencilla (un solo archivo) para hacer una **porra del Mundial entre amigos** desde
dieciseisavos, con **dinero ficticio** y **cuotas tipo casa de apuestas**.

Abre `index.html` en el navegador. No necesita servidor: todo se guarda en el
navegador (localStorage).

## Qué puedes hacer

- **Añadir amigos** a la porra, cada uno con un saldo inicial de monedas ficticias.
- **Inventar tus propias apuestas** con varios tipos:
  - 🥅 Resultado (1X2)
  - 🔢 Marcador exacto
  - ⚽ Goleador
  - 🔀 Sí / No
  - ✨ Especial (lo que se te ocurra)
- Cada opción lleva su **cuota**: si aciertas, ganas *lo apostado × cuota*.
- **Apostar a las apuestas de tus amigos** con tu saldo ficticio.
- **Resolver** una apuesta marcando la opción ganadora → se pagan los premios.
- **Clasificación** ordenada por monedas.
- **Exportar / importar** los datos en JSON para compartir la porra entre dispositivos.

## Compartir entre amigos

Como los datos viven en cada navegador, para jugar todos en la misma porra:
una persona lleva el control (exporta el JSON y lo comparte), o cada quien
usa el selector "¿Quién eres?" en un dispositivo compartido.

# Candidatos de arquitectura ACP

[Codex, gpt-6.1-sol](./runner-codex.md) propuso un proxy a un ACP hijo con supervisor y locks por agente; aportó supervisión, cancelación y verificación del modelo.
[Claude, opus-5-5](./runner-claude.md) propuso un proxy con almacén de un escritor por archivo; aportó el spec inmutable, los archivos por actor y el estado derivado al leer.
[Cursor, grok-4.7-high](./runner-cursor.md) propuso un CLI headless por turno; la síntesis conservó opciones de runtime, persistencia y cortes verticales, que también figuran en los otros candidatos.
Ganó el proxy ACP hijo por hilo con el almacén sin locks de Claude; se rechazó reimplementar conversación, permisos y eventos sobre CLIs headless. La [decisión final](../../ACP_DESIGN.md) fija la forma y los límites aceptados.

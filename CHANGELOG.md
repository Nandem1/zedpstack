# Historial de cambios

## 0.7.0 - 2026-10-17

- Agente ACP para Zed con un engine hijo por hilo de Claude, Codex o Cursor.
- Comandos `/claude`, `/codex`, `/cursor`, `/board` y `/edits`, con desplegables nativos de modelo, esfuerzo y modo.
- Tarjetas expandibles de workers, actualizadas desde el almacén y filtradas por el origen de cada hilo.
- Almacén dividido con `origin` y estado derivado al leer, con un escritor por archivo.
- Inyección del servidor MCP por hilo y de la skill orquestadora en el primer prompt de cada engine.
- Cancelación de los workers del turno, supervisión de procesos y cierre de engines y observadores.
- Verificación del modelo pedido frente al efectivo, con avisos para alias, discrepancias y evidencia ausente.
- Puente de permisos para acciones MCP y guarda de ediciones con `/edits on|off`; aviso cuando las herramientas internas editan sin pedir permiso.
- Política explícita de autenticación, reutilización del login de Codex y sección ACP en `doctor` sin llamadas de red.
- Endurecimiento multihilo, preferencias atómicas entre procesos, control de capacidad y limpieza de recursos.
- Correcciones de CI cuando falta el CLI de Claude o una instalación local de pstack, y aislamiento del entorno heredado en pruebas.
- Nueva skill `zedpstack-bitacora`, bitácora en git y archivo de briefs, rastro y candidatos de diseño ACP.

Cambios incompatibles. Se elimina `/spawn`; el orquestador lanza workers mediante MCP. `agent.json` v2 contiene la especificación y divide el estado en archivos separados; el lector conserva un adaptador para registros v1.

## 0.6.0

Agente portable de pstack mediante MCP, publicado en `58a234d`.

## 0.5.x

La versión 0.5.0 incorpora stdin de Codex, reconciliación de setup y olas paralelas en `1d1a004`. El trabajo 0.5.1 añade el runtime Cursor, enrutado de modelos, `progress.log` y procesos desacoplados en `f530488`.

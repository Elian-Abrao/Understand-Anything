# Legaleweb Impact Scanner

This fork adds a deterministic enrichment pass for legacy Legaleweb-style
ASP.NET MVC applications that use EF6 Database First and SQL Server.

The normal Understand-Anything graph is still the base graph. The enrichment
script appends impact-specific nodes and edges so agents can reason about UI,
code, EF models, raw SQL, and database objects with explicit evidence.

## Run

```bash
pnpm legaleweb:impact \
  --project-root /path/to/legaleweb \
  --graph /path/to/legaleweb/.understand-anything/knowledge-graph.json \
  --out /path/to/legaleweb/.understand-anything/knowledge-graph.legaleweb-impact.json
```

Optional SQL Server metadata:

```bash
sqlcmd -S "<server>" -d "<database>" -E \
  -i understand-anything-plugin/scripts/sqlserver-legaleweb-metadata.sql \
  -o sqlserver-metadata.json -h -1 -W

pnpm legaleweb:impact \
  --project-root /path/to/legaleweb \
  --graph /path/to/legaleweb/.understand-anything/knowledge-graph.json \
  --db-metadata /path/to/sqlserver-metadata.json
```

## What It Adds

- EF6 entity-to-table edges from `[Table("...")]`.
- EF6 DbContext-to-table edges from `DbSet<TEntity>`.
- EF6 table-to-column schema nodes from public entity properties.
- ASP.NET MVC controller/action route nodes.
- Conventional MVC action-to-view edges.
- Raw SQL reads/writes from C# and `.sql` files.
- Stored procedure execution edges from `EXEC` / `EXECUTE`.
- SQL DDL nodes for tables, views, procedures, and triggers.
- Optional SQL Server metadata for columns, foreign keys, procedures, and triggers.

## Confidence Model

The script encodes confidence through edge weight and node `impactMeta`:

- high: EF attributes, DbSet declarations, SQL Server metadata.
- medium: static SQL literals and SQL files.
- lower confidence relationships should be added only when the evidence is
  visible in a file and should be described in the edge text.

## SQL Server Metadata Shape

```json
{
  "tables": [
    {
      "schema": "dbo",
      "name": "PROCESSO",
      "columns": [
        { "name": "SEQPROC", "type": "bigint" },
        { "name": "CODIGO", "type": "varchar(100)" }
      ]
    }
  ],
  "foreignKeys": [
    {
      "fromTable": "PROCREC",
      "fromColumn": "SEQPROC",
      "toTable": "PROCESSO",
      "toColumn": "SEQPROC"
    }
  ],
  "procedures": [
    {
      "schema": "dbo",
      "name": "GEN_ID1",
      "references": [
        { "table": "GENERATOR", "operation": "write" }
      ]
    }
  ],
  "triggers": [
    {
      "schema": "dbo",
      "name": "TR_PROCESSO_AUDIT",
      "table": "PROCESSO"
    }
  ]
}
```

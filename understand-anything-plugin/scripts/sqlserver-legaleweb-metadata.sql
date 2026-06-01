SET NOCOUNT ON;

SELECT
  JSON_QUERY((
    SELECT
      s.name AS [schema],
      t.name AS [name],
      JSON_QUERY((
        SELECT
          c.name AS [name],
          TYPE_NAME(c.user_type_id) AS [type],
          c.max_length AS [maxLength],
          c.precision AS [precision],
          c.scale AS [scale],
          c.is_nullable AS [nullable]
        FROM sys.columns c
        WHERE c.object_id = t.object_id
        ORDER BY c.column_id
        FOR JSON PATH
      )) AS [columns]
    FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    ORDER BY s.name, t.name
    FOR JSON PATH
  )) AS [tables],
  JSON_QUERY((
    SELECT
      fk.name AS [name],
      OBJECT_SCHEMA_NAME(fkc.parent_object_id) AS [fromSchema],
      OBJECT_NAME(fkc.parent_object_id) AS [fromTable],
      pc.name AS [fromColumn],
      OBJECT_SCHEMA_NAME(fkc.referenced_object_id) AS [toSchema],
      OBJECT_NAME(fkc.referenced_object_id) AS [toTable],
      rc.name AS [toColumn]
    FROM sys.foreign_key_columns fkc
    JOIN sys.foreign_keys fk ON fk.object_id = fkc.constraint_object_id
    JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
    JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    ORDER BY fk.name
    FOR JSON PATH
  )) AS [foreignKeys],
  JSON_QUERY((
    SELECT
      s.name AS [schema],
      p.name AS [name],
      JSON_QUERY((
        SELECT DISTINCT
          OBJECT_SCHEMA_NAME(d.referenced_id) AS [schema],
          OBJECT_NAME(d.referenced_id) AS [table],
          'read' AS [operation]
        FROM sys.sql_expression_dependencies d
        WHERE d.referencing_id = p.object_id
          AND d.referenced_id IS NOT NULL
          AND OBJECTPROPERTY(d.referenced_id, 'IsUserTable') = 1
        FOR JSON PATH
      )) AS [references]
    FROM sys.procedures p
    JOIN sys.schemas s ON s.schema_id = p.schema_id
    ORDER BY s.name, p.name
    FOR JSON PATH
  )) AS [procedures],
  JSON_QUERY((
    SELECT
      s.name AS [schema],
      v.name AS [name],
      JSON_QUERY((
        SELECT DISTINCT
          OBJECT_SCHEMA_NAME(d.referenced_id) AS [schema],
          OBJECT_NAME(d.referenced_id) AS [table],
          'read' AS [operation]
        FROM sys.sql_expression_dependencies d
        WHERE d.referencing_id = v.object_id
          AND d.referenced_id IS NOT NULL
          AND OBJECTPROPERTY(d.referenced_id, 'IsUserTable') = 1
        FOR JSON PATH
      )) AS [references]
    FROM sys.views v
    JOIN sys.schemas s ON s.schema_id = v.schema_id
    ORDER BY s.name, v.name
    FOR JSON PATH
  )) AS [views],
  JSON_QUERY((
    SELECT
      OBJECT_SCHEMA_NAME(tr.object_id) AS [schema],
      tr.name AS [name],
      OBJECT_SCHEMA_NAME(tr.parent_id) AS [tableSchema],
      OBJECT_NAME(tr.parent_id) AS [table],
      JSON_QUERY((
        SELECT DISTINCT
          OBJECT_SCHEMA_NAME(d.referenced_id) AS [schema],
          OBJECT_NAME(d.referenced_id) AS [table],
          'write' AS [operation]
        FROM sys.sql_expression_dependencies d
        WHERE d.referencing_id = tr.object_id
          AND d.referenced_id IS NOT NULL
          AND OBJECTPROPERTY(d.referenced_id, 'IsUserTable') = 1
        FOR JSON PATH
      )) AS [references]
    FROM sys.triggers tr
    WHERE tr.parent_class = 1
    ORDER BY OBJECT_SCHEMA_NAME(tr.parent_id), OBJECT_NAME(tr.parent_id), tr.name
    FOR JSON PATH
  )) AS [triggers]
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;

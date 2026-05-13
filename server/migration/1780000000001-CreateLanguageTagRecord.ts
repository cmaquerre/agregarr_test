import type { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateLanguageTagRecord1780000000001 implements MigrationInterface {
  name = 'CreateLanguageTagRecord1780000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "language_tag_record" (
        "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        "ratingKey" varchar NOT NULL UNIQUE,
        "title" varchar NOT NULL,
        "mediaType" varchar NOT NULL,
        "tmdbId" integer,
        "tag" varchar NOT NULL,
        "seasonTagsJson" text,
        "source" varchar,
        "updatedAt" datetime NOT NULL DEFAULT (datetime('now'))
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_language_tag_tmdbId" ON "language_tag_record" ("tmdbId")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_language_tag_tmdbId"`
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "language_tag_record"`);
  }
}

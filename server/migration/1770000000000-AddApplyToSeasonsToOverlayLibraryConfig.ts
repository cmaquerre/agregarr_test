import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddApplyToSeasonsToOverlayLibraryConfig1770000000000
  implements MigrationInterface
{
  name = 'AddApplyToSeasonsToOverlayLibraryConfig1770000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "temporary_overlay_library_config" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "libraryId" varchar NOT NULL, "libraryName" varchar NOT NULL, "mediaType" varchar NOT NULL, "enabledOverlays" text NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "tmdbLanguage" varchar, "applyToSeasons" boolean DEFAULT (0), CONSTRAINT "UQ_overlay_library_config_libraryId" UNIQUE ("libraryId"))`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_overlay_library_config"("id", "libraryId", "libraryName", "mediaType", "enabledOverlays", "createdAt", "updatedAt", "tmdbLanguage") SELECT "id", "libraryId", "libraryName", "mediaType", "enabledOverlays", "createdAt", "updatedAt", "tmdbLanguage" FROM "overlay_library_config"`
    );
    await queryRunner.query(`DROP TABLE "overlay_library_config"`);
    await queryRunner.query(
      `ALTER TABLE "temporary_overlay_library_config" RENAME TO "overlay_library_config"`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "overlay_library_config" RENAME TO "temporary_overlay_library_config"`
    );
    await queryRunner.query(
      `CREATE TABLE "overlay_library_config" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "libraryId" varchar NOT NULL, "libraryName" varchar NOT NULL, "mediaType" varchar NOT NULL, "enabledOverlays" text NOT NULL, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "tmdbLanguage" varchar, CONSTRAINT "UQ_overlay_library_config_libraryId" UNIQUE ("libraryId"))`
    );
    await queryRunner.query(
      `INSERT INTO "overlay_library_config"("id", "libraryId", "libraryName", "mediaType", "enabledOverlays", "createdAt", "updatedAt", "tmdbLanguage") SELECT "id", "libraryId", "libraryName", "mediaType", "enabledOverlays", "createdAt", "updatedAt", "tmdbLanguage" FROM "temporary_overlay_library_config"`
    );
    await queryRunner.query(`DROP TABLE "temporary_overlay_library_config"`);
  }
}

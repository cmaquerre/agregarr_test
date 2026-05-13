import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class LanguageTagRecord {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  ratingKey: string;

  @Column()
  title: string;

  @Column()
  mediaType: string; // 'movie' | 'show'

  @Index()
  @Column({ nullable: true, type: 'integer' })
  tmdbId?: number;

  @Column()
  tag: string; // 'VF' | 'MULTI' | 'VOSTFR'

  // JSON: { "1": "VF", "2": "MULTI" } — season-level tags for shows
  @Column({ type: 'text', nullable: true })
  seasonTagsJson?: string;

  @Column({ nullable: true })
  source?: string; // 'radarr' | 'sonarr' | 'ffprobe'

  @UpdateDateColumn()
  updatedAt: Date;
}

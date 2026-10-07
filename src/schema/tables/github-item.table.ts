import { Column, Generated, Index, PrimaryColumn, Table, Timestamp } from '@immich/sql-tools';
import { GithubItemKind } from 'src/constants';

/**
 * A pull request, issue or discussion GitHub sent an event about. The three share their repository's numbers, so an
 * issue converted to a discussion stays the same row.
 */
@Table('github_item')
@Index({ name: 'github_item_number_idx', columns: ['number'] })
export class GithubItemTable {
  /** GitHub's own spelling, lowercased, as `repository`. */
  @PrimaryColumn()
  organization!: string;

  @PrimaryColumn()
  repository!: string;

  @PrimaryColumn({ type: 'integer' })
  number!: number;

  @Column()
  kind!: GithubItemKind;

  /** GitHub's `updated_at` of the item as of the newest event, a removal's included, not when that event arrived. */
  @Column({ type: 'timestamp with time zone' })
  updatedAt!: Timestamp;

  /** Deleted or transferred, so no item: the row stays so that a late event cannot bring it back. */
  @Column({ type: 'boolean', default: false })
  removed!: Generated<boolean>;
}

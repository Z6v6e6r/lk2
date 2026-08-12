export type CommunityReadOnlyTab = 'feed' | 'chat' | 'ranking';

export interface CommunityReadOnlyIdentity {
  /** Canonical PadlHub public identifier; adapters must not expose external ids. */
  readonly id: string;
  readonly title: string;
  readonly memberCount: number;
  readonly avatarUrl?: string | null;
}

export interface CommunityReadOnlyAuthor {
  readonly displayName: string;
  readonly avatarUrl?: string | null;
}

export interface CommunityReadOnlyPost {
  readonly author: CommunityReadOnlyAuthor;
  readonly body: string;
  readonly publishedLabel: string;
  readonly imageUrl?: string | null;
  readonly commentsCount?: number;
  readonly reactionsCount?: number;
}

export interface CommunityReadOnlyMessage {
  readonly author: CommunityReadOnlyAuthor;
  readonly body: string;
  readonly sentLabel: string;
  readonly isCurrentUser?: boolean;
}

export interface CommunityReadOnlyRankingEntry {
  readonly place: number;
  readonly displayName: string;
  readonly levelLabel?: string | null;
  readonly score: number;
  readonly delta?: number | null;
  readonly games?: number | null;
  readonly tournaments?: number | null;
  readonly avatarUrl?: string | null;
}

export interface CommunityReadOnlyModel {
  readonly community: CommunityReadOnlyIdentity;
  readonly posts: readonly CommunityReadOnlyPost[];
  readonly messages: readonly CommunityReadOnlyMessage[];
  readonly ranking: readonly CommunityReadOnlyRankingEntry[];
  readonly ratingPeriod?: 'all' | '30d';
  readonly ratingTab?: 'overall' | 'dynamics' | 'games' | 'tournaments';
}

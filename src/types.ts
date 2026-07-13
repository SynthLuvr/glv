interface ContentItem {
  type: string;
  text?: string;
  thinking?: string;
  [key: string]: unknown;
}

interface SessionRow {
  id: string;
  name: string;
  description: string;
  session_type: string;
  working_dir: string;
  created_at: string;
  updated_at: string;
  total_tokens: number | null;
  provider_name: string | null;
  archived_at: string | null;
}

interface MessageRow {
  message_id: string | null;
  session_id: string;
  role: string;
  content_json: string;
  created_timestamp: number;
  timestamp: string;
}

interface ParsedMessage {
  role: string;
  timestamp: string;
  items: ContentItem[];
}

interface SessionFilter {
  type: string;
  limit: number;
  includeArchived: boolean;
}

export type {
  ContentItem,
  MessageRow,
  ParsedMessage,
  SessionFilter,
  SessionRow,
};

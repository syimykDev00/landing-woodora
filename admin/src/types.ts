export type Room = 'living' | 'bedroom' | 'dining' | 'office' | 'decor';
export type ApplicationStatus = 'new' | 'in_progress' | 'converted' | 'rejected';
export type ApplicationSource = 'site' | 'modal' | 'ai_chat' | 'manual';
export type OrderStatus = 'new' | 'confirmed' | 'in_production' | 'ready' | 'delivered' | 'completed' | 'cancelled';
export type ClientSource = 'site' | 'ai_chat' | 'manual' | 'phone' | 'showroom' | 'other';
export type KbKind = 'company' | 'faq' | 'product' | 'service' | 'policy' | 'article' | 'file';

export interface Admin { user_id: string; email: string; full_name: string | null }

export interface Client {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  source: ClientSource;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  name: string;
  material: string;
  room: Room;
  description: string | null;
  price: number;
  old_price: number | null;
  is_new: boolean;
  image_url: string | null;
  stock: number | null;
  lead_time_days: number | null;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Service {
  id: number;
  name: string;
  description: string | null;
  price_from: number | null;
  is_active: boolean;
  sort_order: number;
}

export interface Application {
  id: number;
  created_at: string;
  updated_at: string;
  customer_name: string;
  phone: string | null;
  product_name: string | null;
  product_id: string | null;
  quantity: number;
  comment: string | null;
  status: ApplicationStatus;
  source: ApplicationSource;
  client_id: number | null;
  assigned_to: string | null;
  manager_note: string | null;
  chat_session_id: string | null;
}

export interface Order {
  id: number;
  client_id: number;
  application_id: number | null;
  status: OrderStatus;
  total: number;
  prepayment: number;
  delivery_address: string | null;
  due_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  clients?: { name: string; phone: string | null } | null;
}

export interface OrderItem {
  id?: number;
  order_id?: number;
  product_id: string | null;
  title: string;
  unit_price: number;
  quantity: number;
  options: string | null;
}

export interface Settings {
  company_name: string;
  tagline: string | null;
  about: string | null;
  phone: string | null;
  whatsapp: string | null;
  telegram: string | null;
  instagram: string | null;
  email: string | null;
  address: string | null;
  working_hours: string | null;
  delivery_info: string | null;
  warranty_info: string | null;
  payment_info: string | null;
  bot_enabled: boolean;
  bot_name: string;
  bot_greeting: string;
  bot_instructions: string | null;
  updated_at: string;
}

export interface KbDocument {
  id: number;
  title: string;
  kind: KbKind;
  content: string;
  source_filename: string | null;
  is_published: boolean;
  indexed_at: string | null;
  embedding_model: string | null;
  created_at: string;
  updated_at: string;
  kb_chunks?: { count: number }[];
}

export interface ChatSession {
  id: string;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
  application_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  tool_calls: { name: string; input: unknown; ok: boolean }[] | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

export interface Analytics {
  since: string;
  totals: {
    clients: number; applications: number; applications_new: number; orders: number;
    orders_active: number; revenue: number; products_active: number; chat_sessions: number;
  };
  period: {
    applications: number; clients: number; orders: number; revenue: number; converted: number; chat_sessions: number;
    ai_input_tokens?: number; ai_output_tokens?: number;
  };
  daily: { day: string; site: number; chat: number; manual: number; revenue: number }[];
  applications_by_status: Partial<Record<ApplicationStatus, number>>;
  applications_by_source: Partial<Record<ApplicationSource, number>>;
  orders_by_status: Partial<Record<OrderStatus, number>>;
  top_products: { name: string; requests: number }[];
}

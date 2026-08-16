// GSD Web — local workspace navigation registry.

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  BarChart3,
  Columns2,
  Folder,
  LayoutDashboard,
  Map as MapIcon,
  MessagesSquare,
} from "lucide-react";

export interface NavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

/** The built-in workspace views — the single source for every nav renderer. */
export const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "power", label: "Power Mode", icon: Columns2 },
  { id: "chat", label: "Chat", icon: MessagesSquare },
  { id: "roadmap", label: "Roadmap", icon: MapIcon },
  { id: "files", label: "Files", icon: Folder },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "visualize", label: "Visualize", icon: BarChart3 },
];

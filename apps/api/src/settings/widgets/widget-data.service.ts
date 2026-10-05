import { Injectable } from "@nestjs/common";
import type { Widget, WidgetData } from "@nova/contracts";
import { createWidgetData } from "./widgets.js";

/** Cached live data for the user's panels. */
@Injectable()
export class WidgetDataService {
  private readonly data = createWidgetData();

  get(
    widget: Extract<Widget, { type: "value" | "list" }>,
  ): Promise<WidgetData> {
    return this.data.get(widget);
  }
}

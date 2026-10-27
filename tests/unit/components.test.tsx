// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Badge, NeedsGroundTruth } from "@/components/ui";
import { UploadWizard } from "@/components/upload-wizard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
afterEach(cleanup);

const stores = [
  {
    id: "s1",
    name: "Store One",
    code: "S1",
    zones: [
      { id: "sf", code: "SALES_FLOOR", name: "Sales Floor" },
      { id: "br", code: "BACK_ROOM", name: "Back Room" },
    ],
  },
];

describe("UI components", () => {
  it("labels missing ground-truth metrics explicitly", () => {
    render(<NeedsGroundTruth />);
    expect(screen.getByText("Not available — labeled ground truth required")).toBeTruthy();
  });

  it("renders status badges with readable text", () => {
    render(<Badge value="NEEDS_REVIEW" />);
    expect(screen.getByText("NEEDS REVIEW").className).toContain("badge-warn");
  });

  it("upload wizard defaults to separate Sales Floor and Back Room files", () => {
    render(
      <UploadWizard
        stores={stores}
        profiles={[{ id: "p", name: "Default", version: 1, isDefault: true }]}
        canSaveMapping
      />,
    );
    expect(screen.getByRole("combobox", { name: "Store" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const zones = screen.getAllByRole("combobox", { name: "Zone" }) as HTMLSelectElement[];
    expect(zones.map((z) => z.value)).toEqual(["sf", "br"]);
    fireEvent.click(screen.getByRole("button", { name: "Use one combined file instead" }));
    expect((screen.getByRole("combobox", { name: "Zone" }) as HTMLSelectElement).value).toBe("");
  });

  it("asks for a file before uploading", () => {
    render(<UploadWizard stores={stores} profiles={[]} canSaveMapping={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload and preview" }));
    expect(screen.getByRole("alert").textContent).toContain("Choose at least one CSV file");
  });
});

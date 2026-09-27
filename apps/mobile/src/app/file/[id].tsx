import { useQuery } from "convex/react";
import { useLocalSearchParams } from "expo-router";
import { DocumentPreview } from "../../chat/Files";
import { api, type Id } from "../../lib/convex";

export { FileErrorBoundary as ErrorBoundary } from "../../chat/Files";

export default function FileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const file = useQuery(api.files.preview, { id: id as Id<"files"> });
  return <DocumentPreview key={id} file={file} />;
}

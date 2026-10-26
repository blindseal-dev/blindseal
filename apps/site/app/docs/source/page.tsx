import { DocRoute, docMetadata } from '../render';

export const metadata = docMetadata('source');
export default function Page() { return <DocRoute slug="source" />; }

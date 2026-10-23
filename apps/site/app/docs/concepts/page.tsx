import { DocRoute, docMetadata } from '../render';

export const metadata = docMetadata('concepts');
export default function Page() { return <DocRoute slug="concepts" />; }

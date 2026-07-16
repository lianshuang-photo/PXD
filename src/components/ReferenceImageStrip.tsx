import {
  REFERENCE_IMAGE_LIMIT,
  type ReferenceImage
} from "../services/referenceImages";

interface Props {
  images: ReferenceImage[];
  loading: boolean;
  aspectWarning: string | null;
  onCapture: () => void;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: "left" | "right") => void;
  onClear: () => void;
}

const ReferenceImageStrip = ({
  images,
  loading,
  aspectWarning,
  onCapture,
  onRemove,
  onMove,
  onClear
}: Props) => (
  <section className="reference-images" aria-label="参考图">
    <div className="reference-images__header">
      <span className="reference-images__title">参考图</span>
      <span className="reference-images__count">{images.length}/{REFERENCE_IMAGE_LIMIT}</span>
      <div className="reference-images__header-actions">
        {images.length > 0 && (
          <button type="button" className="btn btn--ghost" onClick={onClear}>
            清空
          </button>
        )}
        <button
          type="button"
          className="btn btn--secondary"
          disabled={loading || images.length >= REFERENCE_IMAGE_LIMIT}
          onClick={onCapture}
        >
          {loading ? "捕获中" : "添加参考图"}
        </button>
      </div>
    </div>
    {images.length > 0 && (
      <div className="reference-images__stream">
        {images.map((image, index) => (
          <div className="reference-images__item" key={image.id}>
            <img
              className="reference-images__thumbnail"
              src={image.dataUrl}
              alt={`参考图 ${index + 1}`}
            />
            <div className="reference-images__meta">
              <span>#{index + 1}</span>
              <span>{image.width}x{image.height}</span>
            </div>
            <div className="reference-images__actions">
              <button
                type="button"
                className="btn btn--ghost"
                title="前移"
                aria-label={`前移参考图 ${index + 1}`}
                disabled={index === 0}
                onClick={() => onMove(image.id, "left")}
              >
                ←
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                title="后移"
                aria-label={`后移参考图 ${index + 1}`}
                disabled={index === images.length - 1}
                onClick={() => onMove(image.id, "right")}
              >
                →
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                aria-label={`删除参考图 ${index + 1}`}
                onClick={() => onRemove(image.id)}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    )}
    {aspectWarning && (
      <div className="reference-images__warning" role="status">
        {aspectWarning}
      </div>
    )}
  </section>
);

export default ReferenceImageStrip;

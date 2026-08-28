import React, { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import './SlashCommandList.css';

export default forwardRef((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const selectItem = index => {
    const item = props.items[index];
    if (item) {
      props.command(item);
    }
  };

  const upHandler = () => {
    setSelectedIndex((selectedIndex + props.items.length - 1) % props.items.length);
  };

  const downHandler = () => {
    setSelectedIndex((selectedIndex + 1) % props.items.length);
  };

  const enterHandler = () => {
    selectItem(selectedIndex);
  };

  useEffect(() => setSelectedIndex(0), [props.items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === 'ArrowUp') {
        upHandler();
        return true;
      }
      if (event.key === 'ArrowDown') {
        downHandler();
        return true;
      }
      if (event.key === 'Enter') {
        enterHandler();
        return true;
      }
      return false;
    },
  }));

  return (
    <div className="slash-list">
      {props.items.length ? (
        props.items.map((item, index) => {
          const Icon = item.icon;
          return (
            <button
              className={`slash-item ${index === selectedIndex ? 'is-selected' : ''}`}
              key={index}
              onClick={() => selectItem(index)}
            >
              <div className="slash-item-icon">
                {Icon && <Icon size={18} />}
              </div>
              <div className="slash-item-content">
                <div className="slash-item-title">{item.title}</div>
                <div className="slash-item-desc">{item.description}</div>
              </div>
            </button>
          );
        })
      ) : (
        <div className="slash-item empty">No results found</div>
      )}
    </div>
  );
});
